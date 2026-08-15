const MP4Generator = require('./MP4Generator');
const TimestampConverter = require('./TimestampConverter');
const SampleBuilder = require('./SampleBuilder');
const mkvMetaEngine = require('../../../mkvMetaEngine');
const clusterManager = require('../../../clusterManager');

/**
 * ISOBMFFSerializer
 * Orchestrates the generation of a fragmented MP4 stream from raw MKV clusters.
 */
class ISOBMFFSerializer {
    constructor(track, metadata, fileId, filePath, tdSend, fileEvents, log, options = {}) {
        this.track = track;
        this.metadata = metadata;
        this.fileId = fileId;
        this.filePath = filePath;
        this.tdSend = tdSend;
        this.fileEvents = fileEvents;
        this.log = log;

        // Fragment Policy
        this.targetDurationMs = options.targetDurationMs || 1000;
        this.maxFragmentBytes = options.maxFragmentBytes || 512 * 1024;

        // State
        this.sequenceNumber = 1;
        this.supported = true;
        this.codec = track.codec;
        this.runningDecodeTimeTicks = -1;
    }

    /**
     * Main streaming entry point.
     */
    async streamToResponse(res, requestedStartTimeMs, signal) {
        console.log(`[ENTRY] ISOBMFFSerializer.streamToResponse | start=${requestedStartTimeMs}`);
        this.log(`[ISOBMFF] [SESSION START] File: ${this.fileId} Track: ${this.track.number} Start: ${requestedStartTimeMs}ms`);
        this.runningDecodeTimeTicks = -1;

        try {
            // Resolve Starting Position
            const startPoint = mkvMetaEngine.getClusterForTime(this.fileId, requestedStartTimeMs, this.track.number);
            if (!startPoint) throw new Error("Could not find start cluster");

            let clusterOffset = startPoint.startOffset;
            let processedOffsets = new Set();
            let pendingPackets = [];
            let fragmentStartTime = -1;
            let actualAudioStartTimeMs = -1;
            let initSegmentSent = false;

            // 1. Cluster Pumping Loop
            while (!signal.aborted && clusterOffset < this.metadata.fileSize) {
                if (processedOffsets.has(clusterOffset)) break;

                const result = await this._ensureCluster(clusterOffset, signal);
                if (signal.aborted) break;

                const registry = clusterManager.getRegistry(this.fileId);
                const cluster = registry.clusters.get(clusterOffset);

                if (cluster && cluster.packets) {
                    const packets = cluster.packets.get(this.track.number) || [];

                    for (const packet of packets) {
                        if (signal.aborted) break;
                        if (packet.time < requestedStartTimeMs) continue;

                        // Capture actual start time of the first packet we will send
                        if (actualAudioStartTimeMs === -1) {
                            actualAudioStartTimeMs = packet.time;
                            this.log(`[ISOBMFF] Actual audio start time identified: ${actualAudioStartTimeMs}ms`);

                            // 2. NOW set headers and send Init Segment
                            res.setHeader('Content-Type', 'audio/mp4');
                            res.setHeader('Cache-Control', 'no-cache');
                            res.setHeader('X-Audio-Requested-Start-Ms', requestedStartTimeMs.toString());
                            res.setHeader('X-Audio-Actual-Start-Ms', actualAudioStartTimeMs.toString());
                            res.flushHeaders();

                            const initSegment = MP4Generator.generateInitSegment(this.track);
                            res.write(initSegment);
                            initSegmentSent = true;
                        }

                        if (fragmentStartTime === -1) fragmentStartTime = packet.time;
                        pendingPackets.push(packet);

                        // Threshold check: duration or size
                        const currentDur = packet.time - fragmentStartTime;
                        const currentSize = pendingPackets.reduce((s, p) => s + p.payload.length, 0);

                        if (currentDur >= this.targetDurationMs || currentSize >= this.maxFragmentBytes) {
                            this._writeFragment(res, pendingPackets, fragmentStartTime);
                            pendingPackets = [];
                            fragmentStartTime = -1;
                        }
                    }
                }

                processedOffsets.add(clusterOffset);

                if (cluster && cluster.endOffset > clusterOffset) {
                    clusterOffset = cluster.endOffset;
                } else {
                    break;
                }

                await new Promise(r => setImmediate(r));
            }

            // Flush any remaining packets
            if (!signal.aborted && pendingPackets.length > 0) {
                this._writeFragment(res, pendingPackets, fragmentStartTime);
            }

            this.log(`[ISOBMFF] [SESSION END] Stream completed successfully`);

        } catch (err) {
            if (signal.aborted) {
                this.log(`[ISOBMFF] Stream aborted by client`);
            } else {
                this.log(`[ISOBMFF ERROR] ${err.message}`);
            }
        } finally {
            if (!res.writableEnded) res.end();
        }
    }

    /**
     * Internal helper to build and send a single moof+mdat pair.
     */
    _writeFragment(res, packets, startTimeMs) {
        const timescale = this.track.sampleRate || 44100;

        if (this.runningDecodeTimeTicks === -1) {
            this.runningDecodeTimeTicks = BigInt(Math.round(startTimeMs * (timescale / 1000)));
            this.log(`[ISOBMFF-TIMELINE] Initialized timeline at ${startTimeMs}ms (${this.runningDecodeTimeTicks} ticks)`);
        }

        const tfdt = this.runningDecodeTimeTicks;
        const samples = SampleBuilder.buildSamples(packets, timescale);
        const fragmentDurationTicks = samples.reduce((acc, s) => acc + s.duration, 0);

        const firstPTS = packets[0].time;
        const lastPTS = packets[packets.length - 1].time;

        // Forensic Metrics
        const sourceSyncDrift = (Number(tfdt) / (timescale / 1000)) - firstPTS;

        this.log(`[SERIALIZER-CONTINUITY] Frag#${this.sequenceNumber} | tfdt=${tfdt} | samples=${samples.length} | SourceDrift=${sourceSyncDrift.toFixed(2)}ms`);

        // Check for packet order
        let unordered = false;
        for (let i = 1; i < packets.length; i++) {
            if (packets[i].time < packets[i-1].time) unordered = true;
        }
        if (unordered) this.log(`  - !!! WARNING: UNORDERED PACKETS DETECTED !!!`);

        const fragment = MP4Generator.generateFragment(this.sequenceNumber, samples, Number(tfdt));

        // Update state - FORCE ABSOLUTE CONTINUITY
        this.runningDecodeTimeTicks += BigInt(fragmentDurationTicks);

        res.write(fragment);
        this.sequenceNumber++;
    }

    /**
     * Reuses existing ClusterManager synchronization logic.
     */
    async _ensureCluster(offset, signal) {
        while (!signal.aborted) {
            const status = await clusterManager.ensureCluster(
                this.fileId, this.filePath, { startOffset: offset },
                this.track.number, this.tdSend, this.fileEvents, this.log
            );

            if (status.state === 'WAITING_FOR_BYTES') {
                await new Promise(resolve => {
                    const wake = () => {
                        this.fileEvents.removeListener(`update_${this.fileId}`, wake);
                        signal.removeEventListener('abort', wake);
                        resolve();
                    };
                    this.fileEvents.once(`update_${this.fileId}`, wake);
                    signal.addEventListener('abort', wake);
                });
                continue;
            }
            return status;
        }
    }
}

module.exports = ISOBMFFSerializer;
