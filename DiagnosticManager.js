const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { app } = require('electron');

/**
 * DiagnosticManager - Centralized logging and ZIP bundle generation.
 * Uses PowerShell Compress-Archive on Windows for zero-dependency ZIPs.
 */
class DiagnosticManager {
    constructor() {
        this.sections = {
            manifest: "{}",
            backend: [],
            mp4box: [],
            transport: [],
            player: [],
            sync: [],
            environment: {},
            session: {
                fileId: null,
                filename: null,
                extension: null,
                backend: "none",
                manifestSuccess: false,
                playbackStarted: false,
                metadataReady: false,
                mp4boxReady: false,
                transportRequests: 0,
                errors: []
            }
        };

        this.initEnvironment();
    }

    initEnvironment() {
        this.sections.environment = {
            version: "StreamVault-Phase2-Audit",
            electron: process.versions.electron,
            node: process.versions.node,
            chrome: process.versions.chrome,
            platform: process.platform,
            arch: process.arch
        };
    }

    log(category, message) {
        const timestamp = new Date().toISOString();
        const line = `[${timestamp}] ${message}`;

        if (this.sections[category] && Array.isArray(this.sections[category])) {
            this.sections[category].push(line);
            if (this.sections[category].length > 15000) this.sections[category].shift();
        }

        if (message.toLowerCase().includes('error')) {
            this.sections.session.errors.push(line);
        }
    }

    setManifest(json) {
        this.sections.manifest = JSON.stringify(json, null, 2);
        this.sections.session.manifestSuccess = true;
    }

    setSessionInfo(key, value) {
        this.sections.session[key] = value;
    }

    generateBundle() {
        const tempDir = path.join(os.tmpdir(), `SV-Diag-${Date.now()}`);
        try {
            if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

            // 1. Write individual files to temp dir
            fs.writeFileSync(path.join(tempDir, 'manifest.json'), this.sections.manifest);
            fs.writeFileSync(path.join(tempDir, 'environment.json'), JSON.stringify(this.sections.environment, null, 2));
            fs.writeFileSync(path.join(tempDir, 'current-session.json'), JSON.stringify(this.sections.session, null, 2));

            const logCategories = ['backend', 'mp4box', 'transport', 'player', 'sync'];
            logCategories.forEach(cat => {
                fs.writeFileSync(path.join(tempDir, `${cat}.log`), this.sections[cat].join('\n'));
            });

            // 2. Prepare output path
            const now = new Date();
            const dateStr = now.toISOString().replace(/:/g, '-').split('.')[0].replace('T', '_');
            const zipName = `StreamVault-Debug-${dateStr}.zip`;
            const downloadsPath = path.join(process.env.USERPROFILE || process.env.HOME, 'Downloads', zipName);

            // 3. Create ZIP using PowerShell (Windows specific)
            if (process.platform === 'win32') {
                const cmd = `powershell.exe -Command "Compress-Archive -Path '${tempDir}\\*' -DestinationPath '${downloadsPath}' -Force"`;
                execSync(cmd);
                console.log(`[DIAGNOSTICS] ZIP Bundle saved to: ${downloadsPath}`);
            } else {
                // Fallback for other platforms (unlikely in this context but good practice)
                const cmd = `zip -r "${downloadsPath}" "${tempDir}"/*`;
                execSync(cmd);
            }

        } catch (e) {
            console.error(`[DIAGNOSTICS] Failed to generate ZIP bundle: ${e.message}`);
            // Fallback to text file if ZIP fails
            try {
                const txtPath = path.join(process.env.USERPROFILE || process.env.HOME, 'Downloads', `StreamVault-Error-Fallback.txt`);
                fs.writeFileSync(txtPath, `ZIP Failed: ${e.message}\n\n` + JSON.stringify(this.sections, null, 2));
            } catch(e2) {}
        } finally {
            // 4. Cleanup temp dir
            try {
                if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
            } catch(e) {}
        }
    }
}

module.exports = new DiagnosticManager();
