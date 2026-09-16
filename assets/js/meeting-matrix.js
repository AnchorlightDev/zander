/**
 * Meeting Availability Matrix
 *
 * Renders the response grid on a meeting poll: one row per proposed time slot,
 * a three-state yes/maybe/no control on each.
 *
 * Responses are all-or-nothing — the API rejects a submission that does not
 * cover every slot — so Submit stays disabled until every row has an answer,
 * and the counter says how many are still outstanding.  The server enforces
 * the same rule; this only stops the user wasting a round trip.
 *
 * Mount point:  <div id="meetingMatrix"
 *                    data-poll-id="12"
 *                    data-readonly="false"
 *                    data-options='[{optionId, startAt, endAt, label}]'
 *                    data-responses='{"3":"yes"}'></div>
 */
(function () {
  'use strict';

  const CHOICES = [
    { value: 'yes', label: 'Yes', className: 'btn-outline-success' },
    { value: 'maybe', label: 'Maybe', className: 'btn-outline-warning' },
    { value: 'no', label: 'No', className: 'btn-outline-secondary' },
  ];

  const root = document.getElementById('meetingMatrix');
  if (!root) return;

  const pollId = Number(root.dataset.pollId);
  const readOnly = root.dataset.readonly === 'true';

  let options = [];
  let answers = {};

  try {
    options = JSON.parse(root.dataset.options || '[]');
    answers = JSON.parse(root.dataset.responses || '{}');
  } catch (error) {
    root.textContent = 'Could not load the response grid.';
    return;
  }

  if (options.length === 0) {
    root.innerHTML = '<p class="text-muted">This meeting has no time options yet.</p>';
    return;
  }

  /** "Tue, 3 Jun, 7:00 pm – 8:00 pm" in the viewer's own timezone. */
  function formatSlot(option) {
    const start = new Date(option.startAt);
    const end = new Date(option.endAt);
    if (isNaN(start) || isNaN(end)) return 'Invalid time';

    const day = start.toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
    const timeOpts = { hour: '2-digit', minute: '2-digit' };
    return day + ', ' + start.toLocaleTimeString(undefined, timeOpts) +
      ' – ' + end.toLocaleTimeString(undefined, timeOpts);
  }

  // ── Build ────────────────────────────────────────────────────────────────

  const table = document.createElement('table');
  table.className = 'table align-middle';

  const head = document.createElement('thead');
  head.innerHTML = '<tr><th>Time slot</th><th class="text-end">Your availability</th></tr>';
  table.appendChild(head);

  const body = document.createElement('tbody');

  options.forEach(function (option) {
    const row = document.createElement('tr');
    row.dataset.optionId = String(option.optionId);

    const slotCell = document.createElement('td');
    const slotLabel = document.createElement('strong');
    slotLabel.textContent = formatSlot(option);
    slotCell.appendChild(slotLabel);

    if (option.label) {
      const note = document.createElement('small');
      note.className = 'text-muted d-block';
      note.textContent = option.label;
      slotCell.appendChild(note);
    }

    const choiceCell = document.createElement('td');
    choiceCell.className = 'text-end';

    const group = document.createElement('div');
    group.className = 'btn-group btn-group-sm';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', 'Availability for ' + formatSlot(option));

    CHOICES.forEach(function (choice) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn ' + choice.className;
      button.textContent = choice.label;
      button.dataset.choice = choice.value;
      button.setAttribute('aria-pressed', 'false');
      if (readOnly) button.disabled = true;

      button.addEventListener('click', function () {
        answers[option.optionId] = choice.value;
        paintRow(row, option.optionId);
        refreshSubmitState();
      });

      group.appendChild(button);
    });

    choiceCell.appendChild(group);
    row.appendChild(slotCell);
    row.appendChild(choiceCell);
    body.appendChild(row);

    paintRow(row, option.optionId);
  });

  table.appendChild(body);

  /** Reflect the current answer for one row in its button states. */
  function paintRow(row, optionId) {
    const selected = answers[optionId];

    row.querySelectorAll('button[data-choice]').forEach(function (button) {
      const choice = CHOICES.find(function (c) { return c.value === button.dataset.choice; });
      const isSelected = button.dataset.choice === selected;

      // Bootstrap outline buttons show selection by swapping to the solid
      // variant, so the active choice reads as filled rather than outlined.
      button.className = 'btn ' + (isSelected
        ? choice.className.replace('btn-outline-', 'btn-')
        : choice.className);
      button.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
    });

    row.classList.toggle('table-warning', !selected && !readOnly);
  }

  // ── Footer: status + submit ──────────────────────────────────────────────

  const footer = document.createElement('div');
  footer.className = 'd-flex justify-content-between align-items-center flex-wrap gap-2';

  const status = document.createElement('div');
  status.className = 'small text-muted';
  status.setAttribute('role', 'status');

  const submit = document.createElement('button');
  submit.type = 'button';
  submit.className = 'btn btn-primary';
  submit.textContent = 'Save availability';

  const feedback = document.createElement('div');
  feedback.className = 'alert d-none mt-3';
  feedback.setAttribute('role', 'alert');

  function outstandingCount() {
    return options.filter(function (option) { return !answers[option.optionId]; }).length;
  }

  function refreshSubmitState() {
    const remaining = outstandingCount();

    if (readOnly) {
      status.textContent = remaining === 0
        ? 'Your availability has been recorded.'
        : 'Responses are closed.';
      return;
    }

    submit.disabled = remaining > 0;
    status.textContent = remaining === 0
      ? 'All ' + options.length + ' slots answered.'
      : remaining + ' of ' + options.length + ' slots still need an answer.';
  }

  function showFeedback(type, message) {
    feedback.className = 'alert alert-' + type + ' mt-3';
    feedback.textContent = message;
  }

  submit.addEventListener('click', async function () {
    if (outstandingCount() > 0) return;

    submit.disabled = true;
    const originalLabel = submit.textContent;
    submit.textContent = 'Saving…';

    try {
      const res = await fetch('/api/meetings/respond', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pollId: pollId,
          responses: options.map(function (option) {
            return { optionId: option.optionId, availability: answers[option.optionId] };
          }),
        }),
      });
      const data = await res.json();

      if (data.success) {
        showFeedback('success', 'Availability saved.');
        // Reload so the results table reflects the new answers.
        setTimeout(function () { window.location.reload(); }, 600);
        return;
      }

      showFeedback('danger', data.message || 'Could not save your availability.');
    } catch (error) {
      showFeedback('danger', 'Could not save your availability. Please try again.');
    }

    submit.textContent = originalLabel;
    refreshSubmitState();
  });

  root.appendChild(table);
  footer.appendChild(status);
  if (!readOnly) footer.appendChild(submit);
  root.appendChild(footer);
  root.appendChild(feedback);

  refreshSubmitState();
})();
