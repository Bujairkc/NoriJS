const mkvMetaEngine = require('../../mkvMetaEngine');
const clusterManager = require('../../clusterManager');

/**
 * WebMAudioSerializer
 * Generates a minimal WebM audio-only stream for Opus/Vorbis.
 */
class WebMAudioSerializer {
    constructor(track, metadata, fileId, filePath, tdSend, fileEvents, log) {
        this.track = track;
        this.metadata = metadata;
        this.fileId = fileId;
        this.filePath = filePath;
        this.tdSend = tdSend;
        this.fileEvents = fileEvents;
        this.log = log;
        this.supported = true;
        this.codec = track.codec;
    }

    /**
     * Main streaming loop.
     */
    async streamToResponse(res, startTimeMs, signal) {
        console.log(`[ENTRY] WebMAudioSerializer.streamToResponse | start=${startTimeMs}`);
        try {
            // Validation
            if (!this.track.codecPrivate || !this.track.samplingFrequency || !this.track.channels) {
                res.status(400).json({
                    error: "Missing required codec metadata",
                    codec: this.track.codec,
                    details: {
                        hasPrivate: !!this.track.codecPrivate,
                        hasFreq: !!this.track.samplingFrequency,
                        hasChannels: !!this.track.channels
                    }
                });
                return;
            }

            res.setHeader('Content-Type', 'audio/webm');
            res.setHeader('Cache-Control', 'no-cache');

            // 1. Write WebM Header (EBML, Segment, Info, Tracks)
            this._writeHeader(res);

            // 2. Resolve Starting Position
            const startPoint = mkvMetaEngine.getClusterForTime(this.fileId, startTimeMs, this.track.number);
            if (!startPoint) throw new Error("Could not find start cluster");

            let clusterOffset = startPoint.startOffset;
            let processedOffsets = new Set();

            // 3. Cluster Pumping Loop
            while (!signal.aborted && clusterOffset < this.metadata.fileSize) {
                if (processedOffsets.has(clusterOffset)) break;

                // Use existing ClusterManager to fetch and parse
                const result = await this._ensureCluster(clusterOffset, signal);
                if (signal.aborted) break;

                const registry = clusterManager.getRegistry(this.fileId);
                const cluster = registry.clusters.get(clusterOffset);

                if (cluster && cluster.packets) {
                    const packets = cluster.packets.get(this.track.number) || [];

                    // Write Cluster Header
                    const clusterTimeMs = Math.round((cluster.clusterTimecode * (this.metadata.timecodeScale || 1000000)) / 1000000);
                    res.write(this._createClusterHeader(clusterTimeMs));

                    // Write packets as SimpleBlocks
                    for (const packet of packets) {
                        if (signal.aborted) break;
                        const relTime = packet.time - clusterTimeMs;
                        res.write(this._createSimpleBlock(packet.payload, relTime, 0x80)); // 0x80 = Keyframe
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
        } catch (err) {
            this.log(`[SERIALIZER ERROR] ${err.message}`);
        } finally {
            if (!res.writableEnded) res.end();
        }
    }

    /**
     * Reuses ClusterManager to ensure bytes are available.
     * Fixes listener leak.
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
                        signal.removeEventListener('abort', onAbort);
                        resolve();
                    };
                    const onAbort = () => {
                        this.fileEvents.removeListener(`update_${this.fileId}`, wake);
                        signal.removeEventListener('abort', onAbort);
                        resolve();
                    };
                    this.fileEvents.once(`update_${this.fileId}`, wake);
                    signal.addEventListener('abort', onAbort);
                });
                continue;
            }
            return status;
        }
    }

    /**
     * Writes the static EBML and Track headers.
     */
    _writeHeader(res) {
        // EBML Header
        res.write(Buffer.from([0x1A, 0x45, 0xDF, 0xA3, 0x9F, 0x42, 0x86, 0x81, 0x01, 0x42, 0xF7, 0x81, 0x01, 0x42, 0xF2, 0x81, 0x04, 0x42, 0xF3, 0x81, 0x08, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6D, 0x42, 0x87, 0x81, 0x04, 0x42, 0x85, 0x81, 0x02]));

        // Segment (Unknown size)
        res.write(Buffer.from([0x18, 0x53, 0x80, 0x67, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]));

        // Info
        const info = this._createEBMLMaster(0x1549A966, [
            this._createEBMLInt(0x2AD7B1, this.metadata.timecodeScale || 1000000),
            this._createEBMLString(0x4D80, "StreamVault"),
            this._createEBMLString(0x5741, "StreamVault AudioSerializer")
        ]);
        res.write(info);

        // Tracks
        const trackEntry = [
            this._createEBMLInt(0xD7, this.track.number),
            this._createEBMLInt(0x73C5, Number(this.track.uid || 1n)),
            this._createEBMLInt(0x83, 2), // Audio
            this._createEBMLString(0x86, this.track.codec === 'A_OPUS' ? 'A_OPUS' : 'A_VORBIS'),
            this._createEBMLBinary(0x63A2, this.track.codecPrivate),
            this._createEBMLInt(0x56AA, this.track.codecDelay || 0),
            this._createEBMLInt(0x56BB, this.track.seekPreRoll || 0)
        ];

        if (this.track.samplingFrequency) {
            trackEntry.push(this._createEBMLMaster(0xE1, [
                this._createEBMLFloat(0xB5, this.track.samplingFrequency),
                this._createEBMLInt(0x9F, this.track.channels || 2)
            ]));
        }

        res.write(this._createEBMLMaster(0x1654AE6B, [
            this._createEBMLMaster(0xAE, trackEntry)
        ]));
    }

    _createClusterHeader(timecode) {
        return this._createEBMLMaster(0x1F43B675, [
            this._createEBMLInt(0xE7, timecode)
        ], true); // Header only
    }

    _createSimpleBlock(payload, relTime, flags) {
        const trackVint = this._toVINT(this.track.number);
        const header = Buffer.alloc(trackVint.length + 3);
        trackVint.copy(header, 0);
        header.writeInt16BE(relTime, trackVint.length);
        header[trackVint.length + 2] = flags;

        const sizeVint = this._toVINT(header.length + payload.length);
        const id = Buffer.from([0xA3]);
        return Buffer.concat([id, sizeVint, header, payload]);
    }

    // --- EBML Helpers ---

    _createEBMLInt(id, val) {
        const idBuf = this._toID(id);
        const valBuf = Buffer.alloc(8);
        valBuf.writeBigUInt64BE(BigInt(val));
        let offset = 0; while(offset < 7 && valBuf[offset] === 0) offset++;
        const trimmed = valBuf.slice(offset);
        return Buffer.concat([idBuf, this._toVINT(trimmed.length), trimmed]);
    }

    _createEBMLFloat(id, val) {
        const buf = Buffer.alloc(4);
        buf.writeFloatBE(val);
        return Buffer.concat([this._toID(id), this._toVINT(4), buf]);
    }

    _createEBMLString(id, str) {
        const buf = Buffer.from(str, 'utf8');
        return Buffer.concat([this._toID(id), this._toVINT(buf.length), buf]);
    }

    _createEBMLBinary(id, data) {
        if (!data) return Buffer.alloc(0);
        return Buffer.concat([this._toID(id), this._toVINT(data.length), data]);
    }

    _createEBMLMaster(id, elements, headOnly = false) {
        const content = Buffer.concat(elements);
        const idBuf = this._toID(id);
        if (headOnly) return Buffer.concat([idBuf, this._toVINT(content.length, true)]);
        return Buffer.concat([idBuf, this._toVINT(content.length), content]);
    }

    _toID(id) {
        if (id > 0xFFFFFF) return Buffer.from([(id >> 24) & 0xFF, (id >> 16) & 0xFF, (id >> 8) & 0xFF, id & 0xFF]);
        if (id > 0xFFFF) return Buffer.from([(id >> 16) & 0xFF, (id >> 8) & 0xFF, id & 0xFF]);
        if (id > 0xFF) return Buffer.from([(id >> 8) & 0xFF, id & 0xFF]);
        return Buffer.from([id & 0xFF]);
    }

    _toVINT(val, unknown = false) {
        if (unknown) return Buffer.from([0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);
        let size = 1;
        while (val >= (Math.pow(2, 7 * size) - 1)) size++;
        const buf = Buffer.alloc(size);
        let current = BigInt(val) | (1n << BigInt(7 * size));
        for (let i = size - 1; i >= 0; i--) {
            buf[i] = Number(current & 0xFFn);
            current >>= 8n;
        }
        return buf;
    }
}

module.exports = WebMAudioSerializer;
