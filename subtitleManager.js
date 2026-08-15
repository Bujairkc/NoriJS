const fs = require('fs');
const path = require('path');
const mkvMetaEngine = require('./mkvMetaEngine');
const clusterManager = require('./clusterManager');

/**
 * SubtitleManager - Unified Subtitle Timeline Controller.
 */
class SubtitleManager {
    constructor() {
        this.decoders = {
            'S_TEXT/UTF8': (payload) => payload.toString('utf8'),
            'S_TEXT/ASS': (payload) => this._stripASSTags(payload.toString('utf8')),
            'S_TEXT/SSA': (payload) => this._stripASSTags(payload.toString('utf8')),
        };
    }

    async discoverExternalSubtitles(fileId, localPath) {
        console.log(`[SubtitleManager] Discovering external subs for: ${localPath}`);
        const tracks = [];
        const dir = path.dirname(localPath);
        const fileName = path.basename(localPath, path.extname(localPath));
        try {
            if (!fs.existsSync(dir)) return [];
            const files = fs.readdirSync(dir);
            files.forEach(file => {
                const ext = path.extname(file).toLowerCase();
                if (['.srt', '.ass', '.ssa', '.vtt'].includes(ext) && file.toLowerCase().includes(fileName.toLowerCase())) {
                    tracks.push({
                        id: `external_${file}`,
                        type: 'external',
                        path: path.join(dir, file),
                        label: file,
                        language: this.guessLanguage(file),
                        format: ext.substring(1)
                    });
                }
            });
        } catch (e) {
            console.error(`[SubtitleManager] External discovery error: ${e.message}`);
        }
        console.log(`[SubtitleManager] Found ${tracks.length} external tracks.`);
        return tracks;
    }

    guessLanguage(fileName) {
        const lower = fileName.toLowerCase();
        if (lower.includes('eng') || lower.includes('english')) return 'English';
        if (lower.includes('spa') || lower.includes('spanish')) return 'Spanish';
        if (lower.includes('fra') || lower.includes('french')) return 'French';
        return 'Unknown';
    }

    /**
     * Main Progressive Stream API for Subtitles.
     */
    async streamVTT(track, filePath, tdSend, fileEvents, log, res, signal, startTimeMs = 0, onResolution = null) {
        if (!res.headersSent) {
            res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache');
        }

        res.write("WEBVTT\n\n");

        const fileId = track.fileId;
        const trackNumber = track.trackNumber; // This is the internal MKV number (e.g. 3)
        const decode = this.decoders[track.codec] || ((p) => p.toString('utf8'));

        log(`[SubtitleManager] [STREAM START] Track: ${track.id}, StartTime: ${startTimeMs}ms`);

        let metadata = mkvMetaEngine.getMetadata(fileId);
        if (!metadata) {
            log(`[SubtitleManager] Metadata missing for ${fileId}, parsing...`);
            metadata = await mkvMetaEngine.parse(fileId, filePath, tdSend, fileEvents);
        }
        clusterManager.setMetadata(fileId, metadata);

        try {
            // 1. Resolve Starting Cluster
            const allCues = (metadata.cues && metadata.cues[trackNumber]) || [];
            let currentCueIndex = 0;

            const startPoint = mkvMetaEngine.getClusterForTime(fileId, startTimeMs, trackNumber);
            if (!startPoint) {
                log(`[SubtitleManager] No start point found for ${startTimeMs}ms`);
                if (onResolution) onResolution('NO_CUE');
                return;
            }

            let clusterOffset = startPoint.startOffset;
            let clusterTargetTime = startPoint.timeStart;
            let isCueBased = true;

            // Find where we are in track-specific cues for future jumping
            if (allCues.length > 0) {
                currentCueIndex = allCues.findIndex(c => c.time >= clusterTargetTime);
                if (currentCueIndex === -1) currentCueIndex = allCues.length;
            }

            let processedOffsets = new Set();
            let firstClusterResolved = false;
            let resolutionSent = false;

            // 2. Traversal Loop (Progressive Cluster Walking)
            while (!signal?.aborted && clusterOffset < metadata.fileSize) {
                if (!processedOffsets.has(clusterOffset)) {
                    if (isCueBased) {
                        log(`[SubtitleManager] [FETCH] [CUE JUMP] Time: ${clusterTargetTime}ms -> Cluster: ${clusterOffset}`);
                    } else {
                        log(`[SubtitleManager] [FETCH] [PHYSICAL WALK] Cluster: ${clusterOffset}`);
                    }

                    let ensureResult;
                    while (!signal?.aborted) {
                        ensureResult = await clusterManager.ensureCluster(fileId, filePath, { startOffset: clusterOffset }, trackNumber, tdSend, fileEvents, log);

                        if (ensureResult.state === 'WAITING_FOR_BYTES') {
                            const { waitId, offset: reqOffset, limit: reqLimit, elementStage, clusterOffset: waitClusterOffset } = ensureResult;

                            // 1. Check if we're already aborted before waiting
                            if (signal?.aborted) break;

                            await new Promise(resolve => {
                                const wake = async (fileUpdate) => {
                                    // 2. Kill the listener if the session was aborted
                                    if (signal?.aborted) {
                                        finish();
                                        return;
                                    }

                                    if (!fileUpdate || !fileUpdate.local) { finish(); return; }

                                    const start = fileUpdate.local.download_offset;
                                    const end = start + fileUpdate.local.downloaded_prefix_size;
                                    const isComplete = fileUpdate.local.is_downloading_completed;

                                    // 3. Robust Range Check:
                                    // A range is ready if it's in the window OR if the window has already passed it (on disk).
                                    let rangeReady = isComplete || (reqOffset >= start && (reqOffset + reqLimit) <= end);

                                    // If the window jumped PAST our required offset, verify with TDLib if it's on disk.
                                    if (!rangeReady && !isComplete && reqOffset < start) {
                                        const check = await tdSend({ '@type': 'getFileDownloadedPrefixSize', 'file_id': fileId, 'offset': reqOffset });
                                        if (check && check.size >= reqLimit) {
                                            rangeReady = true;
                                        }
                                    }

                                    log(`[WAKE_PROFILE] WAKE #${waitId} | Pos: ${reqOffset} | Offset: ${start} | Prefix: ${fileUpdate.local.downloaded_prefix_size} | Window: [${start}..${end}] | Ready: ${rangeReady}`);

                                    if (rangeReady) {
                                        finish();
                                    } else {
                                        fileEvents.once(`update_${fileId}`, wake);
                                    }
                                };
                                const finish = () => {
                                    fileEvents.removeListener(`update_${fileId}`, wake);
                                    resolve();
                                };
                                fileEvents.once(`update_${fileId}`, wake);
                            });
                            continue;
                        }
                        break;
                    }

                    if (signal?.aborted) break;

                    const registry = clusterManager.getRegistry(fileId);
                    const cluster = registry.clusters.get(clusterOffset);
                    const packets = (cluster && cluster.packets.get(trackNumber)) || [];

                    const clusterTime = cluster?.clusterTimecode || 0;
                    const timecodeScale = metadata.timecodeScale || 1000000;
                    const clusterStartMs = Math.round((clusterTime * timecodeScale) / 1000000);

                    log(`[SubtitleManager] [EXTRACTED] Cluster: ${clusterOffset}, Packets: ${packets.length} | ClusterStart: ${clusterStartMs}ms`);

                    let foundRelevantCue = false;
                    for (const packet of packets) {
                        if (signal?.aborted) break;

                        // FILTER: Only send subtitles that are actually relevant to the current seek time
                        const packetDuration = packet.duration || 2000;
                        if (packet.time + packetDuration < startTimeMs) continue;

                        const text = decode(packet.payload);
                        if (text && text.trim()) {
                            const cueText = `${this.formatVTTTime(packet.time)} --> ${this.formatVTTTime(packet.time + packetDuration)}\n${text}\n\n`;

                            if (!signal?.aborted) {
                                res.write(cueText);
                            }

                            // Check if this packet covers the target seek time
                            if (packet.time <= startTimeMs && (packet.time + packetDuration) >= startTimeMs) {
                                foundRelevantCue = true;
                            }
                        }
                    }
                    processedOffsets.add(clusterOffset);

                    if (signal?.aborted) break;

                    // Part B: Signal Readiness
                    if (!resolutionSent && onResolution && !signal?.aborted) {
                        if (foundRelevantCue) {
                            log(`[READINESS] Session Resolution -> CUE_FOUND`);
                            onResolution('CUE_FOUND');
                            resolutionSent = true;
                        } else if (clusterStartMs > startTimeMs) {
                            log(`[READINESS] Session Resolution -> NO_CUE (Timeline Passed)`);
                            onResolution('NO_CUE');
                            resolutionSent = true;
                        }
                    }

                    if (!firstClusterResolved) {
                        firstClusterResolved = true;
                        clusterManager.emit(`subtitles_ready_${fileId}`, { time: startTimeMs });
                    }

                    // PHYSICAL WALK: Advance to next cluster based on parsed endOffset
                    if (cluster && cluster.endOffset > clusterOffset) {
                        const nextPhysicalOffset = cluster.endOffset;

                        // If we have track-specific cues ahead, see if we can jump
                        if (currentCueIndex < allCues.length) {
                            const nextCue = allCues[currentCueIndex];
                            const nextCueOffset = metadata.segmentDataOffset + nextCue.clusterPos;

                            if (nextCueOffset > clusterOffset && nextCueOffset <= nextPhysicalOffset) {
                                clusterOffset = nextCueOffset;
                                clusterTargetTime = nextCue.time;
                                isCueBased = true;
                                currentCueIndex++;
                            } else {
                                clusterOffset = nextPhysicalOffset;
                                clusterTargetTime = -1;
                                isCueBased = false;
                            }
                        } else {
                            clusterOffset = nextPhysicalOffset;
                            clusterTargetTime = -1;
                            isCueBased = false;
                        }
                    } else {
                        log(`[SubtitleManager] [WALK ERROR] Cannot determine next cluster after ${clusterOffset}`);
                        if (!resolutionSent && onResolution) onResolution('NO_CUE');
                        break;
                    }
                } else {
                    break;
                }

                const fileState = await tdSend({ '@type': 'getFile', 'file_id': fileId });
                const dlEnd = (fileState.local.download_offset || 0) + (fileState.local.downloaded_prefix_size || 0);

                if (clusterOffset > dlEnd + 10 * 1024 * 1024 && !fileState.local.is_downloading_completed) {
                    await new Promise(r => setTimeout(r, 2000));
                }

                await new Promise(r => setImmediate(r));
            }
        } catch (err) {
            log(`[SubtitleManager] [STREAM ERROR]: ${err.message}`);
            if (onResolution) onResolution('ERROR');
        } finally {
            log(`[SubtitleManager] [STREAM END] Track: ${track.id}`);
            res.end();
        }
    }

    formatVTTTime(ms) {
        if (isNaN(ms)) return "00:00:00.000";
        const h = Math.floor(ms / 3600000).toString().padStart(2, '0');
        const m = Math.floor((ms % 3600000) / 60000).toString().padStart(2, '0');
        const s = Math.floor((ms % 60000) / 1000).toString().padStart(2, '0');
        const mmm = Math.floor(ms % 1000).toString().padStart(3, '0');
        return `${h}:${m}:${s}.${mmm}`;
    }

    _stripASSTags(text) {
        if (!text) return "";
        let clean = text.toString().replace(/\{.*?\}/g, '');
        if (clean.includes(',,')) {
             const parts = clean.split(',');
             if (parts.length >= 10) clean = parts.slice(9).join(',');
        }
        return clean.trim();
    }
}

module.exports = new SubtitleManager();
