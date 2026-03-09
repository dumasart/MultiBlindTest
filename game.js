// ─── Deezer CORS proxy helper ───────────────────────────────────────────────
// Deezer's API doesn't allow direct browser requests; use a public CORS proxy.
const CORS_PROXY = 'https://corsproxy.io/?';
const DEEZER_API = 'https://api.deezer.com';

async function deezerFetch(path) {
  const res = await fetch(CORS_PROXY + encodeURIComponent(DEEZER_API + path));
  if (!res.ok) throw new Error('Deezer API error');
  return res.json();
}

// ─── Track fetching ──────────────────────────────────────────────────────────
async function fetchTracks(query, count) {
  // Fetch more than needed so we can filter out those without previews
  const data = await deezerFetch(`/search?q=${encodeURIComponent(query)}&limit=50`);
  const withPreview = (data.data || []).filter(t => t.preview);
  if (withPreview.length < count) throw new Error('Not enough tracks with previews found.');

  // Shuffle and pick `count` tracks
  const shuffled = withPreview.sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count).map(t => ({
    id: t.id,
    title: t.title_short || t.title,
    artist: t.artist.name,
    album: t.album.title,
    cover: t.album.cover_medium,
    preview: t.preview,
  }));
}

async function fetchTracksFromPlaylist(playlistId, count, excludeIds = new Set()) {
  const data = await deezerFetch(`/playlist/${playlistId}/tracks?limit=100`);
  const withPreview = (data.data || []).filter(t => t.preview && !excludeIds.has(t.id));
  if (withPreview.length < count) throw new Error('Not enough new tracks with previews in this playlist. All tracks may have been played already.');
  const shuffled = withPreview.sort(() => Math.random() - 0.5);
  const picked = shuffled.slice(0, count).map(t => ({
    id: t.id,
    title: t.title_short || t.title,
    artist: t.artist.name,
    album: t.album.title,
    cover: t.album.cover_medium,
    preview: t.preview,
  }));
  // Return total available count alongside tracks so caller can store it
  return { tracks: picked, totalAvailable: withPreview.length };
}

// ─── Playlist search ──────────────────────────────────────────────────────────
async function searchPlaylists(query) {
  const data = await deezerFetch(`/search/playlist?q=${encodeURIComponent(query)}&limit=20`);
  return (data.data || []).map(p => ({ id: p.id, title: p.title, nb_tracks: p.nb_tracks }));
}

// ─── Normalisation for comparison ────────────────────────────────────────────
function normalise(str) {
  return str
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove accents
    .replace(/[^a-z0-9\s]/g, '')                      // remove punctuation
    .replace(/\s+/g, ' ')
    .trim();
}

function isMatch(guess, track) {
  const g = normalise(guess);
  const title = normalise(track.title);
  const artist = normalise(track.artist);

  const MIN_CHARS = 5;

  function fieldMatch(query, target) {
    // Minimum required length: MIN_CHARS, unless the target itself is shorter
    const required = Math.min(MIN_CHARS, target.length);
    if (query.length < required) return false;

    // The guess must also cover at least half the target length
    const halfTarget = Math.ceil(target.length / 2);
    if (query.length < Math.min(halfTarget, MIN_CHARS)) return false;

    // Substring match anywhere in the target
    return target.includes(query);
  }

  return fieldMatch(g, title) || fieldMatch(g, artist);
}

// ─── Game State ───────────────────────────────────────────────────────────────
const state = {
  tracks: [],
  audios: [],
  found: [],
  score: 0,
  totalScore: 0,
  timerInterval: null,
  timeLeft: 60,
  timeLimitEnabled: true,
  playedTrackIds: new Set(),
  totalAvailableInPlaylist: 0,
};

// ─── DOM helpers ─────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(`${name}-screen`).classList.add('active');
}

function showLoading(msg = 'Loading tracks…') {
  let overlay = $('loading-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'loading-overlay';
    overlay.innerHTML = `<div class="spinner"></div><span>${msg}</span>`;
    document.body.appendChild(overlay);
  } else {
    overlay.querySelector('span').textContent = msg;
    overlay.style.display = 'flex';
  }
}

function hideLoading() {
  const overlay = $('loading-overlay');
  if (overlay) overlay.style.display = 'none';
}

// ─── Visualizer bars ─────────────────────────────────────────────────────────
function createVisualizer() {
  const div = document.createElement('div');
  div.className = 'visualizer';
  const speeds = ['0.4s','0.6s','0.5s','0.7s','0.45s','0.55s'];
  const heights = ['28px','36px','22px','40px','30px','24px'];
  for (let i = 0; i < 6; i++) {
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.style.setProperty('--speed', speeds[i % speeds.length]);
    bar.style.setProperty('--max-h', heights[i % heights.length]);
    div.appendChild(bar);
  }
  return div;
}

// ─── Build track cards ────────────────────────────────────────────────────────
function buildTrackCards(tracks) {
  const container = $('tracks-container');
  container.innerHTML = '';

  tracks.forEach((track, i) => {
    const card = document.createElement('div');
    card.className = 'track-card playing';
    card.id = `card-${i}`;

    const num = document.createElement('div');
    num.className = 'track-number';
    num.textContent = `Track ${i + 1}`;

    const badge = document.createElement('div');
    badge.className = 'found-badge';
    badge.textContent = '✓ FOUND';

    const viz = createVisualizer();

    const answer = document.createElement('div');
    answer.className = 'answer-reveal';
    answer.innerHTML = `
      <div class="answer-title">${track.title}</div>
      <div class="answer-artist">by ${track.artist}</div>
    `;

    card.appendChild(num);
    card.appendChild(badge);
    card.appendChild(viz);
    card.appendChild(answer);

    container.appendChild(card);
  });
}

// ─── Global guess handling ────────────────────────────────────────────────────
function handleGlobalGuess(force = false) {
  const input = $('global-guess');
  const hint = $('global-hint');
  const val = input.value;

  if (normalise(val).length < 3) {
    hint.className = 'hint-text';
    hint.textContent = 'Keep typing… (min. 3 characters)';
    return;
  }

  // Try to match against any unfound track
  const matchIndex = state.tracks.findIndex(
    (track, i) => !state.found.includes(i) && isMatch(val, track)
  );

  if (matchIndex !== -1) {
    const hint2 = document.createElement('div'); // dummy, not shown per-card
    markFound(matchIndex, state.tracks[matchIndex]);
    input.value = '';
    hint.className = 'hint-text correct';
    hint.textContent = `✓ "${state.tracks[matchIndex].title}" by ${state.tracks[matchIndex].artist} — correct!`;
    setTimeout(() => {
      if (hint.classList.contains('correct')) {
        hint.className = 'hint-text';
        hint.textContent = 'Keep guessing!';
      }
    }, 2000);
  } else if (force) {
    hint.className = 'hint-text wrong';
    hint.textContent = '✗ No match — try again!';
    setTimeout(() => {
      if (hint.classList.contains('wrong')) {
        hint.className = 'hint-text';
        hint.textContent = 'Keep guessing!';
      }
    }, 1500);
  }
}

// ─── Guess handling (per-card, now unused but kept for markFound) ─────────────
function markFound(index, track) {
  if (state.found.includes(index)) return;
  state.found.push(index);

  const audio = state.audios[index];
  if (audio) { audio.pause(); audio.currentTime = 0; }

  const card = $(`card-${index}`);
  card.classList.remove('playing');
  card.classList.add('found');

  const points = parseInt($('track-count').value) * 10;
  state.score += points;
  state.totalScore += points;
  $('score').textContent = state.totalScore;

  if (state.found.length === state.tracks.length) {
    setTimeout(() => endGame(true), 600);
  }
}

// ─── Timer ────────────────────────────────────────────────────────────────────
function startTimer(seconds) {
  state.timeLeft = seconds;
  const timerEl = $('timer');
  const timerDisplay = $('timer-display');

  if (seconds === 0) {
    timerEl.textContent = '∞';
    state.timeLimitEnabled = false;
    return;
  }

  state.timeLimitEnabled = true;
  timerEl.textContent = seconds;

  state.timerInterval = setInterval(() => {
    state.timeLeft--;
    timerEl.textContent = state.timeLeft;

    if (state.timeLeft <= 10) timerDisplay.classList.add('urgent');

    if (state.timeLeft <= 0) {
      clearInterval(state.timerInterval);
      endGame(false);
    }
  }, 1000);
}

// ─── Game lifecycle ───────────────────────────────────────────────────────────
async function startGame() {
  const count = parseInt($('track-count').value);
  const timeLimit = parseInt($('time-limit').value);
  const playlistId = $('playlist-select').value;

  if (!playlistId) {
    alert('Please search for and select a playlist first.');
    return;
  }

  showLoading('Fetching tracks from playlist…');

  let exhausted = false;
  let result;
  try {
    result = await fetchTracksFromPlaylist(playlistId, count, state.playedTrackIds);
  } catch (err) {
    hideLoading();
    if (state.playedTrackIds.size > 0) {
      exhausted = true;
      state.playedTrackIds.clear();
      showLoading('Playlist exhausted — starting over…');
      try {
        result = await fetchTracksFromPlaylist(playlistId, count, state.playedTrackIds);
      } catch (err2) {
        hideLoading();
        alert('Could not load tracks: ' + err2.message);
        return;
      }
    } else {
      alert('Could not load tracks: ' + err.message);
      return;
    }
  }

  state.tracks = result.tracks;
  state.totalAvailableInPlaylist = result.totalAvailable;

  // Register newly picked tracks as played
  state.tracks.forEach(t => state.playedTrackIds.add(t.id));

  // Reset state
  state.audios.forEach(a => destroyAudio(a));
  state.audios = [];

  // Reset UI from previous game
  const gi = $('global-guess');
  gi.disabled = false;
  gi.value = '';
  $('global-hint').className = 'hint-text';
  $('global-hint').textContent = 'Start guessing!';
  $('guess-bar').style.display = 'flex';
  $('give-up-btn').disabled = false;
  const banner = $('end-banner');
  banner.style.display = 'none';
  banner.innerHTML = '';

  // Build UI
  buildTrackCards(state.tracks);
  showScreen('game');

  // Show exhausted notice in the hint bar after screen switch
  if (exhausted) {
    const hint = $('global-hint');
    hint.className = 'hint-text exhausted';
    hint.textContent = '🔁 All playlist tracks had been played — the list has been reset!';
    setTimeout(() => {
      if (hint.classList.contains('exhausted')) {
        hint.className = 'hint-text';
        hint.textContent = 'Start guessing!';
      }
    }, 4000);
  }

  // Preload and play all audios
  showLoading('Loading audio previews…');

  const failedIndices = [];
  await Promise.all(state.tracks.map((track, i) => new Promise(resolve => {
    const audio = new Audio();
    audio.crossOrigin = 'anonymous';
    audio.src = track.preview;
    audio.volume = 0.7;
    audio.loop = true;
    state.audios[i] = audio;
    audio.addEventListener('canplaythrough', resolve, { once: true });
    audio.addEventListener('error', () => { failedIndices.push(i); resolve(); }, { once: true });
    audio.load();
  })));

  // Replace any tracks whose audio failed to load, retrying until all slots filled
  if (failedIndices.length > 0) {
    let toReplace = [...failedIndices];
    const maxAttempts = 3;

    for (let attempt = 0; attempt < maxAttempts && toReplace.length > 0; attempt++) {
      showLoading(`Replacing ${toReplace.length} unplayable track(s)… (attempt ${attempt + 1})`);
      const excludeForReplacement = new Set([
        ...state.playedTrackIds,
        ...toReplace.map(i => state.tracks[i].id),
      ]);

      let replacements;
      try {
        const replacementResult = await fetchTracksFromPlaylist(playlistId, toReplace.length, excludeForReplacement);
        replacements = replacementResult.tracks;
      } catch (e) {
        break; // No more tracks available
      }

      const stillFailed = [];
      await Promise.all(replacements.map((track, ri) => new Promise(resolve => {
        const i = toReplace[ri];

        // Cleanly destroy the failed audio before replacing
        destroyAudio(state.audios[i]);

        state.tracks[i] = track;
        state.playedTrackIds.add(track.id);

        const audio = new Audio();
        audio.crossOrigin = 'anonymous';
        audio.src = track.preview;
        audio.volume = 0.7;
        audio.loop = true;
        state.audios[i] = audio;

        audio.addEventListener('canplaythrough', () => {
          // Rebuild the card only on success
          const oldCard = $(`card-${i}`);
          const newCard = document.createElement('div');
          newCard.className = 'track-card playing';
          newCard.id = `card-${i}`;

          const num = document.createElement('div');
          num.className = 'track-number';
          num.textContent = `Track ${i + 1}`;

          const badge = document.createElement('div');
          badge.className = 'found-badge';
          badge.textContent = '✓ FOUND';

          const viz = createVisualizer();

          const answer = document.createElement('div');
          answer.className = 'answer-reveal';
          answer.innerHTML = `
            <div class="answer-title">${track.title}</div>
            <div class="answer-artist">by ${track.artist}</div>
          `;

          newCard.appendChild(num);
          newCard.appendChild(badge);
          newCard.appendChild(viz);
          newCard.appendChild(answer);
          if (oldCard) oldCard.replaceWith(newCard);

          resolve();
        }, { once: true });

        audio.addEventListener('error', () => {
          stillFailed.push(i);
          resolve();
        }, { once: true });

        audio.load();
      })));
      toReplace = stillFailed;
    }
  }

  hideLoading();

  // Play all
  state.audios.forEach(audio => {
    audio.play().catch(() => {}); // autoplay may be blocked
  });

  // Start timer
  startTimer(timeLimit);
}

function endGame(won) {
  clearInterval(state.timerInterval);
  state.audios.forEach(a => { a.pause(); }); // pause only, keep src for playback in revealed cards

  // Disable guess input
  const gi = $('global-guess');
  if (gi) { gi.disabled = true; }
  $('give-up-btn').disabled = true;
  $('guess-bar').style.display = 'none';

  // Reveal all unfound cards with individual play buttons
  state.tracks.forEach((track, i) => {
    const card = $(`card-${i}`);
    if (!card) return;
    card.classList.remove('playing');

    if (!state.found.includes(i)) {
      card.classList.add('revealed');
    }

    // Replace track-number with a header row containing track label + play button
    const numEl = card.querySelector('.track-number');
    const header = document.createElement('div');
    header.className = 'revealed-track-header';

    const label = document.createElement('div');
    label.className = 'track-number';
    label.textContent = numEl ? numEl.textContent : `Track ${i + 1}`;

    const playBtn = document.createElement('button');
    playBtn.className = 'play-btn';
    playBtn.title = 'Play / Pause';
    playBtn.innerHTML = '▶';

    let playing = false;
    playBtn.addEventListener('click', () => {
      const audio = state.audios[i];
      if (!audio) return;
      if (playing) {
        audio.pause();
        playBtn.innerHTML = '▶';
      } else {
        // Pause all others
        state.audios.forEach((a, j) => {
          if (j !== i) { a.pause(); }
        });
        document.querySelectorAll('.play-btn').forEach((b, j) => {
          if (j !== i) b.innerHTML = '▶';
        });
        audio.play().catch(() => {});
        playBtn.innerHTML = '⏸';
      }
      playing = !playing;
    });

    // Sync button state when audio ends or is paused externally
    state.audios[i].addEventListener('pause', () => { playing = false; playBtn.innerHTML = '▶'; });
    state.audios[i].addEventListener('play',  () => { playing = true;  playBtn.innerHTML = '⏸'; });

    header.appendChild(label);
    header.appendChild(playBtn);
    if (numEl) numEl.replaceWith(header);
    else card.prepend(header);
  });

  // Compute how many unplayed tracks remain after this round
  const count = parseInt($('track-count').value);
  const remaining = state.totalAvailableInPlaylist - count;
  const lowTracksWarning = remaining < count
    ? `<p class="banner-warning">🎉 You reached the end of the playlist!</p>
       <p class="banner-warning">⚠️ Playing again will reset the list</p>`
    : '';

  const playAgainClass = remaining < count ? 'btn-danger' : 'btn-primary';
  const playAgainText = remaining < count ? '🔄 Restart Playlist': '🔄 Play Again';
  const returnClass = remaining < count ? 'btn-primary' : 'btn-danger';

  // Show end banner
  const banner = $('end-banner');
  banner.innerHTML = `
    <div>
      <h2>${won ? '🎉 You got them all!' : '⏱ Time\'s up!'}</h2>
      <p>You found ${state.found.length} / ${state.tracks.length} tracks — Round score: ${state.score}</p>
      <p>Total score: <strong>${state.totalScore}</strong></p>
      ${lowTracksWarning}
    </div>
    <div class="banner-actions">
      <button id="play-again-btn" class="btn ${playAgainClass}">${playAgainText}</button>
      <button id="return-setup-btn" class="btn ${returnClass}">↩ Return to Setup</button>
    </div>
  `;
  banner.style.display = 'flex';

  $('play-again-btn').addEventListener('click', () => {
    state.audios.forEach(a => { a.pause(); });
    startGame();
  });

  $('return-setup-btn').addEventListener('click', () => {
    state.audios.forEach(a => destroyAudio(a));
    state.audios = [];
    state.playedTrackIds.clear();
    showScreen('setup');
  });
}

// ─── Audio cleanup helper ─────────────────────────────────────────────────────
function destroyAudio(audio) {
  if (!audio) return;
  audio.pause();
  audio.src = '';
  audio.load(); // flush any pending load
}

// ─── Event listeners ──────────────────────────────────────────────────────────
$('search-playlist-btn').addEventListener('click', async () => {
  const query = $('playlist-query').value.trim();
  if (!query) return;

  $('search-playlist-btn').disabled = true;
  $('search-playlist-btn').textContent = '…';

  try {
    const playlists = await searchPlaylists(query);
    const sel = $('playlist-select');
    sel.innerHTML = '';
    if (playlists.length === 0) {
      alert('No playlists found. Try another search term.');
    } else {
      playlists.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = `${p.title} (${p.nb_tracks} tracks)`;
        sel.appendChild(opt);
      });
      $('playlist-select-label').style.display = 'flex';
    }
  } catch (e) {
    alert('Playlist search failed: ' + e.message);
  }

  $('search-playlist-btn').disabled = false;
  $('search-playlist-btn').textContent = 'Search';
});

$('start-btn').addEventListener('click', startGame);
$('give-up-btn').addEventListener('click', () => {
  clearInterval(state.timerInterval);
  endGame(false);
});

const globalGuessInput = $('global-guess');
globalGuessInput.addEventListener('input', () => handleGlobalGuess(false));
globalGuessInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') handleGlobalGuess(true);
});
