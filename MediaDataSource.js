const fs = require('fs');
const transportManager = require('./TransportManager');
const diagnosticManager = require('./DiagnosticManager');

/**
 * MediaDataSource - Parser-facing Data Interface.
 * Provides bytes on demand, waiting for the transport layer if necessary.
 */
class MediaDataSource {
    constructor() {
        this.openFileDescriptors = new Map();
    }

    /**
     * The ONLY method parsers should use to get data.
     */
    async getBytes(fileId, filePath, offset, length, tdSend, fileEvents, log, sessionId = null, signal = null) {
        diagnosticManager.log('transport', `Read Request: file=${fileId} offset=${offset} length=${length} sessionId=${sessionId}`);

        // 1. Ensure bytes are on disk
        const result = await transportManager.ensureRange(fileId, offset, length, tdSend, fileEvents, log, sessionId, signal);
        if (result.state !== 'READY') {
            diagnosticManager.log('transport', `Read Terminated: Transport state=${result.state}`);
            if (result.state === 'ABORTED') return null;
            throw new Error(`Transport failed: ${result.state}`);
        }

        // 2. Read from disk
        let fd = this.openFileDescriptors.get(filePath);
        if (!fd) {
            fd = fs.openSync(filePath, 'r');
            this.openFileDescriptors.set(filePath, fd);
        }

        const buffer = Buffer.alloc(length);
        const bytesRead = fs.readSync(fd, buffer, 0, length, offset);

        diagnosticManager.log('transport', `Read Complete: bytes=${bytesRead}`);

        if (bytesRead < length) {
            return buffer.slice(0, bytesRead);
        }
        return buffer;
    }

    close(filePath) {
        const fd = this.openFileDescriptors.get(filePath);
        if (fd) {
            fs.closeSync(fd);
            this.openFileDescriptors.delete(filePath);
        }
    }
}

module.exports = new MediaDataSource();
