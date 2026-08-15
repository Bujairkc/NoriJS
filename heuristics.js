/**
 * Heuristics for classifying Telegram bot messages and determining content relevance.
 */

const Heuristics = {
  /**
   * isMovieFileButton
   * Determines if an inline button text likely represents a movie file.
   */
  isMovieFileButton(text) {
    if (!text) return false;
    const t = text.toUpperCase();
    const subExts = ['.SRT', '.ASS', '.SSA', '.VTT', '.SUB', '.IDX'];
    if (subExts.some(ext => t.endsWith(ext))) return false;

    const navKeywords = ['START BOT', 'SEND ALL', 'NEXT', 'PREVIOUS', 'BACK', 'HOME', 'PAGES', 'NEXT PAGE', 'PREVIOUS PAGE', 'NO MORE PAGES AVAILABLE'];
    if (navKeywords.some(kw => t.includes(kw))) return false;

    const settingsKeywords = ['QUALITY', 'LANGUAGE', 'LANGUAGES', 'SELECT', 'FILTER', 'SORT', 'EPISODE', 'EPISODES', 'SEASON', 'SEASONS'];
    if (settingsKeywords.some(kw => t.includes(kw))) return false;

    const videoExts = ['MKV', 'MP4', 'AVI', 'MOV', 'WEBM', 'M4V', 'TS'];
    const qualities = ['2160P', '1440P', '1080P', '720P', '480P', '360P', '4K', 'UHD', 'FHD', 'HD', 'SD'];

    // Check for extensions (with dot or space) or quality labels
    const hasExt = videoExts.some(ext => t.endsWith('.' + ext) || t.endsWith(' ' + ext) || t.includes('.' + ext + ' ') || t.includes(' ' + ext + ' '));
    const hasQual = qualities.some(q => t.includes(q));

    return hasExt || hasQual;
  },

  /**
   * isNavigationButton
   */
  isNavigationButton(text) {
    if (!text) return false;
    const t = text.toUpperCase();
    const navKeywords = ['NEXT', 'PREVIOUS', 'BACK', 'PAGES', 'NEXT PAGE', 'PREVIOUS PAGE', 'NEXT ⏩', 'NEXT   >>>'];
    return navKeywords.some(kw => t.includes(kw)) || t.includes('⏩') || t.includes('>>>') || t.includes('<<<');
  },

  /**
   * isRelevant
   * PHASE 7: ADVANCED FILTERING (Conflict Detection & Short-Title Guard)
   */
  async isRelevant(fileName, item) {
    if (!item) return false;

    const normalize = (s) => {
      if (!s) return "";
      return s.toLowerCase()
              .replace(/[^a-z0-9\s]/g, ' ')
              .replace(/\s+/g, ' ')
              .trim();
    };

    // --- STEP 1: EXTRACT REQUESTED CONTEXT ---
    const requestedTitleClean = normalize(item.title || item.label || "").replace(/\d{4}$/, '').trim();
    const requestedYear = String(item.year || "").match(/\b(19|20)\d{2}\b/)?.[0] || null;

    // --- STEP 2: PRE-CLEANUP (Identity-Based Size & Provider Metadata) ---
    let workingName = fileName.trim();
    const sizePattern = /^[\d\.]+\s*(?:gb|mb|kb|b)\b/i;
    const providerAtTag = /^\@[a-z0-9\_]+\s*/i;
    const providerBracket = /^\[[^\]]+\]\s*/;
    const decorativeJunk = /^[\▪\▫\▪️\▫️\•\►\🍿\🔥\✨\⚡\✅\⭐\💎\🔔\📣\📢\🎞\🎬\🎥\●\⭕\🔄\s\:\-\|]+\s*/;

    let preCleaned = true;
    while (preCleaned) {
        preCleaned = false;
        if (sizePattern.test(workingName)) { workingName = workingName.replace(sizePattern, '').trim(); preCleaned = true; }
        if (providerAtTag.test(workingName)) { workingName = workingName.replace(providerAtTag, '').trim(); preCleaned = true; }
        if (providerBracket.test(workingName)) { workingName = workingName.replace(providerBracket, '').trim(); preCleaned = true; }
        if (decorativeJunk.test(workingName)) { workingName = workingName.replace(decorativeJunk, '').trim(); preCleaned = true; }
    }

    // --- STEP 3: DETECT TITLE BOUNDARY ---
    const metaMarkers = [
      /\bs\d+e\d+\b/i, /\b\d+x\d+\b/i, /\bseason\s*\d+\b/i, /\bepisode\s*\d+\b/i,
      /\b\d{3,4}p\b/i, /\b4k\b/i, /\bweb\-?rip\b/i, /\bweb\-?dl\b/i, /\bbluray\b/i,
      /\bhd\-?rip\b/i, /\bdvd\-?rip\b/i, /\bx26[45]\b/i, /\bhevc\b/i, /\baac\b/i,
      /\bddp\b/i, /\bdts\b/i, /\b10bit\b/i, /\b12bit\b/i, /\bmkv\b/i, /\bmp4\b/i, /\bavi\b/i,
      /\b[\[\s]\d{3,4}p[\]\s]/i
    ];

    let boundaryIndex = workingName.length;
    metaMarkers.forEach(regex => {
      const match = workingName.match(regex);
      if (match && match.index < boundaryIndex) boundaryIndex = match.index;
    });

    const yearMatchInFile = workingName.match(/\b(19|20)\d{2}\b/);
    if (yearMatchInFile && yearMatchInFile.index < boundaryIndex && yearMatchInFile.index > 0) {
        boundaryIndex = yearMatchInFile.index;
    }

    const rawExtracted = workingName.substring(0, boundaryIndex);
    const candidateTitleNormalized = normalize(rawExtracted);

    // --- STEP 4: CORE VALIDATION ---
    const titleEquality = (candidateTitleNormalized === requestedTitleClean);

    let yearMatchResult = true;
    if (yearMatchInFile && requestedYear && requestedYear !== "0") {
        yearMatchResult = (yearMatchInFile[0] === requestedYear);
    }

    let episodeMatchResult = true;
    const isSeriesRequested = !!(item.season && item.episode);
    const detectedEpisode = window.parseEpisodeContext(fileName);

    if (isSeriesRequested) {
      if (detectedEpisode) {
          episodeMatchResult = (detectedEpisode.season === item.season && detectedEpisode.episode === item.episode);
      } else {
          episodeMatchResult = false;
      }
    } else if (detectedEpisode) {
      episodeMatchResult = false; // Movie requested, but file is an episode
    }

    // --- STEP 5: FINAL ACCEPTANCE WITH SHORT-TITLE GUARD ---
    let accepted = titleEquality && yearMatchResult && episodeMatchResult;

    // GUARD: If requested title is very short (e.g. "FROM") and candidate is much longer, reject.
    if (!titleEquality && requestedTitleClean.length <= 4 && candidateTitleNormalized.length > requestedTitleClean.length + 8) {
        console.log(`[STRICT REJECT] Candidate "${candidateTitleNormalized}" is too long for short title "${requestedTitleClean}"`);
        accepted = false;
    } else if (!accepted && yearMatchResult && episodeMatchResult && candidateTitleNormalized.length > 2) {
        // Only attempt TMDb AKA verification if basic criteria (Year/Episode) met
        const tmdbVerified = await this.verifyWithTMDB(candidateTitleNormalized, item);
        if (tmdbVerified) accepted = true;
    }

    console.log(`[TITLE OWNERSHIP FINAL AUDIT]`, {
      requestedTitle: requestedTitleClean,
      candidateTitle: candidateTitleNormalized,
      titleEquality,
      yearMatch: yearMatchResult,
      accepted,
      original: fileName
    });

    return accepted;
  },

  /**
   * verifyWithTMDB
   * Refined to prevent "subset" matches (e.g., "From" matching "From Dusk Till Dawn")
   */
  async verifyWithTMDB(candidateTitle, requestedItem) {
    if (!candidateTitle || !requestedItem || !requestedItem.tmdbId) return false;

    const type = requestedItem.type || (requestedItem.sub === "TV SERIES" ? "tv" : "movie");
    const requestedTitleLower = (requestedItem.title || requestedItem.label || "").toLowerCase();
    const cacheKey = `tmdb_v_${type}_${candidateTitle.replace(/\s+/g, '_')}`;

    // 1. Check Local Cache
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
        try {
            const parsed = JSON.parse(cached);
            if (parsed && typeof parsed.result === 'boolean') {
                return parsed.result && String(parsed.id) === String(requestedItem.tmdbId);
            }
        } catch(e) {}
    }

    // 2. Progressive Search Logic
    let words = candidateTitle.split(/\s+/);
    let originalQueryLength = words.length;

    while (words.length > 0) {
        const currentQuery = words.join(' ');
        if (currentQuery.length < 2) break;

        try {
            if (typeof window.fetchTMDB !== 'function') return false;
            const endpoint = type === 'movie' ? '/search/movie' : '/search/tv';

            console.log(`[TMDb SEARCH] query="${currentQuery}"`);
            const data = await window.fetchTMDB(endpoint, { query: currentQuery });

            if (data && data.results && data.results.length > 0) {
                const match = data.results.find(r => String(r.id) === String(requestedItem.tmdbId));

                if (match) {
                    // VERIFICATION: If we found a match by shortening the query,
                    // we must ensure the top result for the ORIGINAL full query wasn't something else.
                    // This prevents "From Dusk Till Dawn" -> search "From" -> Match.
                    if (words.length < originalQueryLength) {
                        const topResult = data.results[0];
                        const topTitle = (topResult.name || topResult.title || "").toLowerCase();
                        if (topTitle !== requestedTitleLower) {
                            console.log(`[TMDb REJECT] Shortened match "${currentQuery}" belongs to different top result: "${topTitle}"`);
                            return false;
                        }
                    }

                    localStorage.setItem(cacheKey, JSON.stringify({ result: true, time: Date.now(), id: requestedItem.tmdbId }));
                    return true;
                }

                // --- CONFLICT DETECTION ---
                const topResult = data.results[0];
                const topTitle = (topResult.name || topResult.title || "").toLowerCase();

                // If top result is a strong match for candidate but NOT our show, this file belongs to the other show.
                if (topTitle === currentQuery || topTitle.startsWith(currentQuery + " ") || currentQuery.startsWith(topTitle + " ")) {
                    console.log(`[TMDb REJECT] Query "${currentQuery}" belongs to "${topTitle}" (ID ${topResult.id}), not our show.`);
                    localStorage.setItem(cacheKey, JSON.stringify({ result: false, time: Date.now(), id: topResult.id }));
                    return false;
                }
            }

            // Stop shortening logic if requested title is very short (like "FROM") to prevent over-stripping.
            if (requestedTitleLower.length <= 4 && currentQuery.length <= requestedTitleLower.length + 2) {
                console.log(`[TMDb STOP] Short title protection: not shortening "${currentQuery}" further.`);
                break;
            }

            words.pop();
        } catch (e) { break; }
    }
    return false;
  }
};

window.Heuristics = Heuristics;
