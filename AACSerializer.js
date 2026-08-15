const mkvMetaEngine = require('../../mkvMetaEngine');
const clusterManager = require('../../clusterManager');

/**
 * AACSerializer
 * Generates an ADTS stream from raw AAC Access Units extracted by ClusterManager.
 *
 * The serializer reads packets from clusterManager (which already handles Matroska
 * lacing/unpacking) and prepends an ADTS header to each raw AAC Access Unit.
 *
 * Browser compatibility: audio/aac (ADTS) is natively supported in Chrome, Firefox,
 * Edge, Safari (desktop), and Safari iOS 15+.
 */
class AACSerializer {
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
        this._diagnosticsLogged = false;

        // Pre-compute ADTS header parameters from track metadata
        this._initADTSParams();
    }

    /**
     * Initialize ADTS encoding parameters from track metadata.
     *
     * Matroska stores the AudioSpecificConfig (ASC) in CodecPrivate (2 bytes for AAC LC).
     * Byte 0: audioObjectType (5 bits) | samplingFrequencyIndex (4 bits) | channelConfiguration (1 bit MSB)
     * Byte 1: channelConfiguration (2 bits LSB) | frameLengthFlag (1 bit) | dependsOnCoreCoder (1 bit) | extensionFlag (1 bit)
     */
    _initADTSParams() {
        const cp = this.track.codecPrivate;

        if (!cp || cp.length < 2) {
            // Fallback: assume AAC LC (profile 1), 48kHz, stereo
            this.profile = 1; // AAC LC
            this.samplingFrequencyIndex = 3; // 48000 Hz
            this.channelConfiguration = 2; // stereo
            this.log(`[AACSerializer] Warning: CodecPrivate missing or too short, using defaults (LC, 48kHz, stereo)`);
        } else {
            const byte0 = cp[0];
            const byte1 = cp[1];

            // Parse AudioSpecificConfig (RFC 3640 / ISO 14496-3)
            // Byte 0: audioObjectType(5) | samplingFrequencyIndex(4) | channelConfig>>1 (1)
            // Byte 1: channelConfig&1 | frameLengthFlag(1) | dependsOnCoreCoder(1) | extensionFlag(1)
            const audioObjectType = (byte0 >> 3) & 0x1F;
            const samplingFrequencyIndex = ((byte0 & 0x07) << 1) | ((byte1 >> 7) & 0x01);
            const channelConfiguration = ((byte1 >> 3) & 0x0F);

            // audioObjectType 2 = AAC LC, 5 = HE-AAC (SBR), 29 = PS
            // For ADTS we use the base object type (AAC LC = 2, but ADTS uses profile = objectType - 1)
            // Profile: 0 = AAC Main, 1 = AAC LC, 2 = SSR, 3 = LTP
            const profile = audioObjectType - 1;

            this.audioObjectType = audioObjectType;
            this.profile = profile >= 0 ? profile : 1; // Default to AAC LC (1)
            this.samplingFrequencyIndex = samplingFrequencyIndex;
            this.channelConfiguration = channelConfiguration;

            this.log(`[AACSerializer] Parsed ASC: objectType=${audioObjectType}, profile=${this.profile}, sampleRateIdx=${samplingFrequencyIndex}, channels=${channelConfiguration}`);
        }

        // Standard sampling frequency table (ISO/IEC 13818-7)
        this.samplingRates = [
            96000, 88200, 64000, 48000, 44100, 32000,
            24000, 22050, 16000, 12000, 11025, 8000, 7350, 0, 0, 0
        ];
    }

    /**
     * Generate a 7-byte ADTS header for a single AAC frame.
     *
     * ADTS Header Format (RFC 3640 / ISO 13818-7):
     * syncword (12 bits) = 0xFFF
     * ID (1) = 0 (MPEG-4)
     * layer (2) = 0
     * protection_absent (1) = 1 (no CRC)
     * profile (2) = profile (0=Main, 1=LC, 2=SSR, 3=LTP)
     * sampling_frequency_index (4)
     * private_bit (1) = 0
     * channel_configuration (3)
     * original_copy (1) = 0
     * home (1) = 0
     * copyright_identification_bit (1) = 0
     * copyright_identification_start (1) = 0
     * frame_length (13) = header_size + frame_size
     * adts_buffer_fullness (11) = 0x7FF (VBR)
     * number_of_raw_data_blocks_in_frame (2) = 0
     */
    _createADTSHeader(frameLength) {
        const frameSize = frameLength + 7; // 7 bytes ADTS header + frame

        const header = Buffer.alloc(7);

        // Byte 0: syncword (12 bits) = 0xFFF
        header[0] = 0xFF;
        header[1] = 0xF0;

        // Byte 1 continued: ID=0, layer=00, protection_absent=1, profile[1:0]
        header[1] |= (0x00 << 3) | (0x00 << 1) | 0x01 | ((this.profile >> 1) & 0x01);

        // Byte 2: profile LSB, samplingFrequencyIndex(4), private_bit, channelConfiguration(2 MSB)
        header[2] = ((this.profile & 0x01) << 7) |
                    (this.samplingFrequencyIndex << 3) |
                    ((this.channelConfiguration >> 1) & 0x03);

        // Byte 3: channelConfiguration LSB, original_copy, home, copyright_id_bit, copyright_id_start, frame_length[12:11]
        header[3] = ((this.channelConfiguration & 0x01) << 7) |
                    ((frameSize >> 11) & 0x03);

        // Byte 4: frame_length[10:3]
        header[4] = (frameSize >> 3) & 0xFF;

        // Byte 5: frame_length[2:0], adts_buffer_fullness[10:8]
        header[5] = ((frameSize & 0x07) << 5) | 0x1F;

        // Byte 6: adts_buffer_fullness[7:0], number_of_raw_data_blocks
        header[6] = 0xFC; // buffer_fullness = 0x7FF, raw_data_blocks = 0

        return header;
    }

    /**
     * Stream the AAC track as an ADTS stream to the HTTP response.
     *
     * @param {http.ServerResponse} res - Express response object
     * @param {number} startTimeMs - Start time in milliseconds for seeking
     * @param {AbortSignal} signal - AbortController signal for cancellation
     */
    async streamToResponse(res, startTimeMs, signal) {
        console.log(`[ENTRY] AACSerializer.streamToResponse | start=${startTimeMs}`);
        try {
            res.setHeader('Content-Type', 'audio/aac');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Accept-Ranges', 'bytes');

            // Resolve starting cluster using existing metadata engine
            const startPoint = mkvMetaEngine.getClusterForTime(this.fileId, startTimeMs, this.track.number);
            if (!startPoint) {
                throw new Error("Could not find start cluster for AAC stream");
            }

            let clusterOffset = startPoint.startOffset;
            let processedOffsets = new Set();

            this.log(`[AACSerializer] Starting stream at ${startTimeMs}ms, cluster offset ${clusterOffset}`);

            // Cluster pumping loop - identical pattern to WebMAudioSerializer
            while (!signal?.aborted && clusterOffset < this.metadata.fileSize) {
                if (processedOffsets.has(clusterOffset)) break;

                // Ensure cluster is parsed and available
                const result = await this._ensureCluster(clusterOffset, signal);
                if (signal?.aborted) break;

                const registry = clusterManager.getRegistry(this.fileId);
                const cluster = registry.clusters.get(clusterOffset);

                if (cluster && cluster.packets) {
                    const packets = cluster.packets.get(this.track.number) || [];

                    const clusterTimeMs = Math.round(
                        (cluster.clusterTimecode * (this.metadata.timecodeScale || 1000000)) / 1000000
                    );

                    // Filter packets to start time
                    for (const packet of packets) {
                        if (signal?.aborted) break;
                        if (packet.time < startTimeMs) continue;

                        // Generate ADTS header for this frame
                        const adtsHeader = this._createADTSHeader(packet.payload.length);

                        if (!this._diagnosticsLogged) {
                            this._diagnosticsLogged = true;
                            const cp = this.track.codecPrivate;
                            this.log(`[AAC-DIAG] CodecPrivate Length: ${cp ? cp.length : 0}`);
                            this.log(`[AAC-DIAG] CodecPrivate Hex: ${cp ? cp.toString('hex') : 'null'}`);
                            this.log(`[AAC-DIAG] Audio Object Type: ${this.audioObjectType}`);
                            this.log(`[AAC-DIAG] Sampling Freq Index: ${this.samplingFrequencyIndex}`);
                            this.log(`[AAC-DIAG] Channel Config: ${this.channelConfiguration}`);
                            this.log(`[AAC-DIAG] First ADTS Header: ${adtsHeader.toString('hex')}`);
                            this.log(`[AAC-DIAG] First Packet Payload Length: ${packet.payload.length}`);
                            this.log(`[AAC-DIAG] First Packet Payload (64 bytes): ${packet.payload.slice(0, 64).toString('hex')}`);
                        }

                        // Write ADTS header + raw AAC payload
                        res.write(adtsHeader);
                        res.write(packet.payload);
                    }
                }

                processedOffsets.add(clusterOffset);

                // Advance to next cluster
                if (cluster && cluster.endOffset > clusterOffset) {
                    clusterOffset = cluster.endOffset;
                } else {
                    break;
                }

                // Cooperative yielding
                await new Promise(r => setImmediate(r));
            }
        } catch (err) {
            this.log(`[AACSerializer] Error: ${err.message}`);
        } finally {
            if (!res.writableEnded) res.end();
        }
    }

    /**
     * Ensure cluster is parsed and available.
     * Reuses ClusterManager's existing infrastructure.
     */
    async _ensureCluster(offset, signal) {
        while (!signal?.aborted) {
            const status = await clusterManager.ensureCluster(
                this.fileId, this.filePath, { startOffset: offset },
                this.track.number, this.tdSend, this.fileEvents, this.log
            );

            if (status.state === 'WAITING_FOR_BYTES') {
                await new Promise(resolve => {
                    const wake = () => {
                        this.fileEvents.removeListener(`update_${this.fileId}`, wake);
                        signal?.removeEventListener('abort', wake);
                        resolve();
                    };
                    this.fileEvents.once(`update_${this.fileId}`, wake);
                    signal?.addEventListener('abort', wake);
                });
                continue;
            }
            return status;
        }
    }
}

module.exports = AACSerializer;