/**
 * Meeting Session Player
 *
 * Drives the recorded-meeting page: audio playback across a session that may
 * hold several recordings, an agenda sidebar that seeks on click, a comment
 * track under the scrubber, a voice-note recorder, and progress reporting.
 *
 * ANCHOR RULE, mirrored from the server: every offset here is milliseconds
 * from the start of the MEETING, not from the start of the audio file that
 * happens to be loaded.  A session with two recordings — the bot dropped and
 * rejoined — has a gap between them that exists on the timeline and in no file.
 * offsetToSource() and sourceToOffset() are the only two places that convert,
 * and everything else works in meeting offsets.
 *
 * Mount point:  <div id="meetingPlayer"
 *                    data-session-id="12"
 *                    data-duration-ms="5400000"
 *                    data-recordings="[{recordingId,url,startOffsetMs,durationMs}]"
 *                    data-agenda="[{itemId,title,startOffsetMs,endOffsetMs,status}]"
 *                    data-comments="[{commentId,username,atOffsetMs,kind,body}]"
 *                    data-gaps="[{startOffsetMs,endOffsetMs}]"
 *                    data-can-comment="true"
 *                    data-last-offset-ms="0"></div>
 *
 * Attributes are escaped JSON in DOUBLE quotes — never raw in single quotes.
 * A meeting title, an agenda item and a comment are all free text written by
 * other people; see tests/unit/meetingViewEscaping.test.mjs for the two stored
 * XSS shapes this avoids.
 */
(function () {
  'use strict';

  const root = document.getElementById('meetingPlayer');
  if (!root) return;

  const sessionId = Number(root.dataset.sessionId);
  const durationMs = Number(root.dataset.durationMs) || 0;
  const canComment = root.dataset.canComment === 'true';

  let recordings = [];
  let agenda = [];
  let comments = [];
  let gaps = [];

  try {
    recordings = JSON.parse(root.dataset.recordings || '[]');
    agenda = JSON.parse(root.dataset.agenda || '[]');
    comments = JSON.parse(root.dataset.comments || '[]');
    gaps = JSON.parse(root.dataset.gaps || '[]');
  } catch (error) {
    root.textContent = 'Could not load this meeting.';
    return;
  }

  recordings.sort((a, b) => a.startOffsetMs - b.startOffsetMs);

  let currentRecordingId = recordings.length ? recordings[0].recordingId : null;
  let lastReportedMs = Number(root.dataset.lastOffsetMs) || 0;

  // ── Timeline maths ───────────────────────────────────────────────────────

  /** Meeting offset -> which file, and how far into it. Mirrors locateOffset(). */
  function offsetToSource(offsetMs) {
    for (const recording of recordings) {
      const end = recording.startOffsetMs + recording.durationMs;
      if (offsetMs >= recording.startOffsetMs && offsetMs < end) {
        return { recording, withinMs: offsetMs - recording.startOffsetMs };
      }
    }

    // In a gap: jump forward to the next piece of audio there is, rather than
    // doing nothing and looking broken.
    const next = recordings.find((recording) => recording.startOffsetMs > offsetMs);
    return next ? { recording: next, withinMs: 0 } : null;
  }

  /** Position inside the loaded file -> meeting offset. */
  function sourceToOffset(withinSeconds) {
    const recording = recordings.find((row) => row.recordingId === currentRecordingId);
    if (!recording) return 0;
    return recording.startOffsetMs + Math.round(withinSeconds * 1000);
  }

  function formatOffset(ms) {
    if (ms == null) return '—';
    const total = Math.floor(ms / 1000);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    const pad = (value) => String(value).padStart(2, '0');
    return hours > 0 ? hours + ':' + pad(minutes) + ':' + pad(seconds) : minutes + ':' + pad(seconds);
  }

  // ── Layout ───────────────────────────────────────────────────────────────

  const audio = document.createElement('audio');
  audio.controls = true;
  audio.preload = 'metadata';
  audio.className = 'w-100';

  const track = document.createElement('div');
  track.className = 'meeting-track';

  const status = document.createElement('div');
  status.className = 'small text-muted mt-1';

  const wrapper = document.createElement('div');
  wrapper.className = 'meeting-player';
  wrapper.appendChild(audio);
  wrapper.appendChild(track);
  wrapper.appendChild(status);
  root.appendChild(wrapper);

  if (recordings.length === 0) {
    status.textContent = 'No audio has been filed for this meeting yet.';
    audio.style.display = 'none';
  } else {
    loadRecording(recordings[0], 0);
  }

  function loadRecording(recording, withinMs) {
    currentRecordingId = recording.recordingId;
    audio.src = recording.url;
    audio.currentTime = Math.max(0, withinMs / 1000);
  }

  /** Seek by MEETING offset, crossing between files where it has to. */
  function seekTo(offsetMs) {
    const located = offsetToSource(offsetMs);
    if (!located) return;

    if (located.recording.recordingId !== currentRecordingId) {
      loadRecording(located.recording, located.withinMs);
      audio.play().catch(() => {});
      return;
    }

    audio.currentTime = located.withinMs / 1000;
  }

  // ── Comment + gap markers under the scrubber ─────────────────────────────

  function renderTrack() {
    track.innerHTML = '';
    if (!durationMs) return;

    for (const gap of gaps) {
      const width = ((gap.endOffsetMs - gap.startOffsetMs) / durationMs) * 100;
      if (width <= 0) continue;
      const marker = document.createElement('div');
      marker.className = 'meeting-track-gap';
      marker.style.left = (gap.startOffsetMs / durationMs) * 100 + '%';
      marker.style.width = width + '%';
      marker.title = 'No audio for this part of the meeting';
      track.appendChild(marker);
    }

    for (const item of agenda) {
      if (item.startOffsetMs == null) continue;
      const marker = document.createElement('button');
      marker.type = 'button';
      marker.className = 'meeting-track-chapter';
      marker.style.left = (item.startOffsetMs / durationMs) * 100 + '%';
      // textContent, not innerHTML: an agenda title is free text.
      marker.title = item.title + ' — ' + formatOffset(item.startOffsetMs);
      marker.addEventListener('click', () => seekTo(item.startOffsetMs));
      track.appendChild(marker);
    }

    for (const comment of comments) {
      if (comment.atOffsetMs == null) continue;
      const marker = document.createElement('button');
      marker.type = 'button';
      marker.className = 'meeting-track-comment' + (comment.kind === 'voice' ? ' is-voice' : '');
      marker.style.left = (comment.atOffsetMs / durationMs) * 100 + '%';
      marker.title = comment.username + ' at ' + formatOffset(comment.atOffsetMs);
      marker.addEventListener('click', () => {
        seekTo(comment.atOffsetMs);
        const target = document.getElementById('comment-' + comment.commentId);
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      track.appendChild(marker);
    }
  }

  renderTrack();

  // ── Agenda sidebar ───────────────────────────────────────────────────────

  document.querySelectorAll('[data-seek-offset]').forEach((element) => {
    const offset = Number(element.dataset.seekOffset);
    if (!Number.isFinite(offset)) return;

    element.addEventListener('click', (event) => {
      event.preventDefault();
      seekTo(offset);
      window.scrollTo({ top: root.offsetTop - 80, behavior: 'smooth' });
    });
  });

  // ── Progress reporting ───────────────────────────────────────────────────

  function currentOffsetMs() {
    return sourceToOffset(audio.currentTime);
  }

  function highlightCurrentChapter(offsetMs) {
    document.querySelectorAll('[data-agenda-item]').forEach((element) => {
      const start = Number(element.dataset.startOffsetMs);
      const end = Number(element.dataset.endOffsetMs);
      const active =
        Number.isFinite(start) && offsetMs >= start && (!Number.isFinite(end) || offsetMs < end);
      element.classList.toggle('active', active);
    });
  }

  audio.addEventListener('timeupdate', () => {
    const offsetMs = currentOffsetMs();
    status.textContent = formatOffset(offsetMs) + ' of ' + formatOffset(durationMs);
    highlightCurrentChapter(offsetMs);
  });

  /**
   * Roll on to the next recording when this one runs out, so a session with a
   * reconnect in the middle plays straight through.
   */
  audio.addEventListener('ended', () => {
    const current = recordings.find((row) => row.recordingId === currentRecordingId);
    if (!current) return;
    const next = recordings.find((row) => row.startOffsetMs > current.startOffsetMs);
    if (!next) return;
    loadRecording(next, 0);
    audio.play().catch(() => {});
  });

  /**
   * Reported every 15 seconds rather than on every timeupdate, which fires
   * several times a second.  The server keeps the furthest point reached, so a
   * dropped report costs nothing.
   */
  function reportProgress(extra) {
    const offsetMs = currentOffsetMs();
    if (!extra && Math.abs(offsetMs - lastReportedMs) < 5000) return;
    lastReportedMs = offsetMs;

    fetch('/api/meetings/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ sessionId: sessionId, lastOffsetMs: offsetMs }, extra || {})),
    }).catch(() => {});
  }

  setInterval(() => {
    if (!audio.paused) reportProgress();
  }, 15000);

  audio.addEventListener('pause', () => reportProgress());
  audio.addEventListener('ended', () => reportProgress({ completed: true }));

  const caughtUpButton = document.getElementById('meetingMarkCaughtUp');
  if (caughtUpButton) {
    caughtUpButton.addEventListener('click', async () => {
      caughtUpButton.disabled = true;
      try {
        const response = await fetch('/api/meetings/progress/responded', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: sessionId }),
        });
        const payload = await response.json();
        caughtUpButton.textContent = payload.success ? 'Marked as caught up' : 'Could not save';
      } catch (error) {
        caughtUpButton.textContent = 'Could not save';
        caughtUpButton.disabled = false;
      }
    });
  }

  // ── Commenting ───────────────────────────────────────────────────────────

  const commentForm = document.getElementById('meetingCommentForm');
  if (canComment && commentForm) {
    const offsetField = document.getElementById('meetingCommentOffset');
    const offsetLabel = document.getElementById('meetingCommentOffsetLabel');

    // Stamp the comment where the listener currently is, which is almost always
    // what they mean by "this bit".
    function syncOffset() {
      const offsetMs = currentOffsetMs();
      if (offsetField) offsetField.value = String(offsetMs);
      if (offsetLabel) offsetLabel.textContent = formatOffset(offsetMs);
    }
    audio.addEventListener('timeupdate', syncOffset);
    syncOffset();

    commentForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const data = new FormData(commentForm);

      const response = await fetch('/api/meetings/comments/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: sessionId,
          body: data.get('body'),
          atOffsetMs: data.get('atOffsetMs') || null,
          agendaItemId: data.get('agendaItemId') || null,
          parentCommentId: data.get('parentCommentId') || null,
          visibility: data.get('visibility') || undefined,
        }),
      });

      const payload = await response.json();
      if (payload.success) window.location.reload();
      else alert(payload.message || 'Could not post that comment.');
    });
  }

  // ── Voice notes ──────────────────────────────────────────────────────────

  const recordButton = document.getElementById('meetingVoiceRecord');
  if (canComment && recordButton && window.MediaRecorder) {
    let recorder = null;
    let chunks = [];

    /**
     * Pick a container the browser will actually produce.
     *
     * Chrome and Firefox give webm/opus; iOS Safari gives mp4/aac and supports
     * nothing else.  Both are accepted by the upload endpoint and normalised
     * server-side, so the only job here is to ask for something the browser can
     * do rather than assuming webm and silently failing on every iPhone.
     */
    function pickMimeType() {
      const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/aac'];
      for (const candidate of candidates) {
        if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(candidate)) {
          return candidate;
        }
      }
      return '';
    }

    recordButton.addEventListener('click', async () => {
      if (recorder && recorder.state === 'recording') {
        recorder.stop();
        return;
      }

      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (error) {
        alert('Microphone access was refused, so a voice note cannot be recorded.');
        return;
      }

      const mimeType = pickMimeType();
      recorder = new MediaRecorder(stream, mimeType ? { mimeType: mimeType } : undefined);
      chunks = [];

      recorder.addEventListener('dataavailable', (event) => {
        if (event.data && event.data.size > 0) chunks.push(event.data);
      });

      recorder.addEventListener('stop', async () => {
        stream.getTracks().forEach((mediaTrack) => mediaTrack.stop());
        recordButton.textContent = 'Uploading…';
        recordButton.disabled = true;

        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        const form = new FormData();
        form.append('sessionId', String(sessionId));
        form.append('atOffsetMs', String(currentOffsetMs()));
        // The extension follows the container so the server-side probe and the
        // archive both see something sensible.
        form.append('file', blob, blob.type.indexOf('mp4') >= 0 ? 'note.m4a' : 'note.webm');

        try {
          const response = await fetch('/api/meetings/comments/voice', { method: 'POST', body: form });
          const payload = await response.json();
          if (payload.success) window.location.reload();
          else {
            alert(payload.message || 'Could not upload that voice note.');
            recordButton.textContent = 'Record a voice note';
            recordButton.disabled = false;
          }
        } catch (error) {
          alert('Could not upload that voice note.');
          recordButton.textContent = 'Record a voice note';
          recordButton.disabled = false;
        }
      });

      recorder.start();
      recordButton.textContent = 'Stop and post';
    });
  } else if (recordButton) {
    recordButton.disabled = true;
    recordButton.title = 'This browser cannot record audio.';
  }

  // ── Times in the viewer's own timezone ───────────────────────────────────
  //
  // Never the organiser's, and never the server's: this is a cross-timezone
  // meeting, so every absolute time on the page is stamped as an ISO string in
  // the markup and rendered here against the reader's own locale.
  document.querySelectorAll('.js-datetime').forEach((element) => {
    const parsed = element.dataset.iso ? new Date(element.dataset.iso) : null;
    element.textContent =
      parsed && !isNaN(parsed)
        ? parsed.toLocaleString(undefined, {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            timeZoneName: 'short',
          })
        : element.dataset.fallback || '';
  });
})();
