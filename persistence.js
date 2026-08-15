/**
 * Manages the persistence of download tasks to localStorage.
 */

const DownloadPersistence = {
  saveDownloadsToStorage() {
    if (!window.downloadManager) return;
    const data = [];
    const uniqueEntries = new Set(window.downloadManager.values());
    for (const entry of uniqueEntries) {
      // If the entry already uses the sectioned structure, preserve it.
      // Otherwise, map the legacy structure to the new sectioned one.
      if (entry.taskId && entry.discovery && entry.media) {
          data.push(entry);
          continue;
      }

      const persistentOffset = (entry.diskBytes !== undefined) ? entry.diskBytes : (entry.lastOffset || 0);

      const sectionedEntry = {
        taskId: entry.taskId || `vault_${Math.random().toString(36).substr(2, 9)}_${Date.now()}`,
        discovery: {
            providerId: entry.chatId || entry.discovery?.providerId || "0",
            providerName: entry.addon || entry.discovery?.providerName || "Unknown",
            lookupToken: entry.startParameter || entry.lookupToken || entry.discovery?.lookupToken || null,
            chatId: entry.chatId || entry.discovery?.chatId || "0",
            messageId: entry.itemId || entry.discovery?.messageId || "0",
            botUsername: entry.botUsername || entry.discovery?.botUsername || null
        },
        telegram: {
            fileId: entry.fileId || entry.telegram?.fileId || null,
            remoteId: entry.remoteId || entry.telegram?.remoteId || null,
            telegramUniqueId: entry.uniqueId || entry.telegram?.telegramUniqueId || null,
            originalFileId: entry.originalFileId || entry.telegram?.originalFileId || null
        },
        media: {
            tmdbId: entry.tmdbId || entry.media?.tmdbId || null,
            season: entry.season || entry.media?.season || null,
            episode: entry.episode || entry.media?.episode || null,
            fileName: entry.fileName || entry.media?.fileName || "video.mp4",
            totalSize: entry.totalSize || entry.media?.totalSize || 0,
            type: entry.type || entry.media?.type || "movie",
            poster: entry.poster || entry.media?.poster || null,
            backdrop: entry.backdrop || entry.media?.backdrop || null,
            sub: entry.sub || entry.media?.sub || null,
            g: entry.g || entry.media?.g || null
        },
        progress: {
            networkBytes: entry.networkBytes || entry.progress?.networkBytes || 0,
            diskBytes: entry.diskBytes || entry.progress?.diskBytes || 0,
            lastOffset: persistentOffset,
            state: entry.state === 'completed' ? 'completed' : (entry.state === 'error' ? 'error' : 'paused'),
            identityStatus: entry.identityStatus || 'BOUND',
            lastVerified: entry.lastVerified || Date.now(),
            savePath: entry.savePath || entry.progress?.savePath || null
        }
      };
      data.push(sectionedEntry);
    }
    localStorage.setItem('sv_active_downloads', JSON.stringify(data));
  },

  loadRawDownloads() {
    const stored = localStorage.getItem('sv_active_downloads');
    if (!stored) return [];
    try {
      return JSON.parse(stored);
    } catch (e) {
      console.error("[PERSISTENCE] JSON parse error", e);
      return [];
    }
  }
};

let _saveTimeout = null;
function throttleSaveDownloads() {
  if (_saveTimeout) return;
  _saveTimeout = setTimeout(() => {
    DownloadPersistence.saveDownloadsToStorage();
    _saveTimeout = null;
  }, 2000);
}

// Global Exports
window.saveDownloadsToStorage = () => DownloadPersistence.saveDownloadsToStorage();
window.throttleSaveDownloads = throttleSaveDownloads;
window.DownloadPersistence = DownloadPersistence;
