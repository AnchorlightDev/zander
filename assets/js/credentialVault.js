/*
 * Credential Vault browser behaviour.
 *
 * Security notes
 *  - Secrets are only ever requested through the reauthentication modal, one
 *    action at a time. The one-time challenge token lives in a local variable
 *    for at most ~30 seconds and is never written to storage.
 *  - Revealed values are written with textContent (never innerHTML), hidden
 *    again after the server-configured period, and wiped when the page is
 *    hidden or left. Nothing is kept in localStorage, sessionStorage,
 *    IndexedDB, cookies or the URL.
 *  - Copy writes straight to the clipboard without rendering the value.
 */
(function () {
  "use strict";

  var BASE = "/dashboard/credentials";
  var ACTION_LABELS = {
    reveal: "Reveal",
    copy: "Copy",
    reveal_version: "Reveal an earlier version",
    restore_version: "Restore an earlier version",
  };

  // ------------------------------------------------------------------
  // Small helpers
  // ------------------------------------------------------------------

  function $(id) {
    return document.getElementById(id);
  }

  function toast(message) {
    var el = $("cvToast");
    var body = $("cvToastBody");
    if (!el || !body || !window.bootstrap) {
      return;
    }
    body.textContent = message;
    window.bootstrap.Toast.getOrCreateInstance(el, { delay: 4000 }).show();
  }

  function postJson(url, payload) {
    return fetch(url, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
    }).then(function (res) {
      return res
        .json()
        .catch(function () {
          return {};
        })
        .then(function (data) {
          return { ok: res.ok && data && data.success === true, status: res.status, data: data || {} };
        });
    });
  }

  // ------------------------------------------------------------------
  // Revealed values
  // ------------------------------------------------------------------

  var revealTimers = {};

  function hideSecret(targetId) {
    var target = $(targetId);
    if (!target) return;
    target.textContent = "";
    target.hidden = true;
    var countdown = $(targetId + "-countdown");
    if (countdown) countdown.textContent = "";
    var hideBtn = document.querySelector('[data-cv-hide="' + targetId + '"]');
    if (hideBtn) {
      hideBtn.hidden = true;
      var mask = hideBtn.getAttribute("data-mask");
      if (mask && $(mask)) $(mask).hidden = false;
    }
    if (revealTimers[targetId]) {
      clearInterval(revealTimers[targetId]);
      delete revealTimers[targetId];
    }
  }

  function hideAllSecrets() {
    Object.keys(revealTimers).forEach(hideSecret);
    document.querySelectorAll(".cv-secret-value").forEach(function (el) {
      el.textContent = "";
      el.hidden = true;
    });
  }

  function showSecret(targetId, maskId, value, seconds) {
    var target = $(targetId);
    if (!target) return;
    hideSecret(targetId);
    target.textContent = value;
    target.hidden = false;
    if (maskId && $(maskId)) $(maskId).hidden = true;
    var hideBtn = document.querySelector('[data-cv-hide="' + targetId + '"]');
    if (hideBtn) hideBtn.hidden = false;
    var remaining = Math.max(1, Number(seconds) || 15);
    var countdown = $(targetId + "-countdown");
    var tick = function () {
      if (countdown) countdown.textContent = "Hiding in " + remaining + "s";
      remaining -= 1;
      if (remaining < 0) hideSecret(targetId);
    };
    tick();
    revealTimers[targetId] = setInterval(tick, 1000);
  }

  // Anything revealed disappears when the tab is hidden, the page is left,
  // or restored from the back/forward cache.
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") hideAllSecrets();
  });
  window.addEventListener("pagehide", hideAllSecrets);
  window.addEventListener("pageshow", function (event) {
    if (event.persisted) hideAllSecrets();
  });

  // ------------------------------------------------------------------
  // Clipboard
  // ------------------------------------------------------------------

  var clipboardTimer = null;

  function copyValue(value, clearAfterSeconds) {
    if (!navigator.clipboard || !navigator.clipboard.writeText) {
      toast("This browser does not allow copying from here.");
      return;
    }
    navigator.clipboard.writeText(value).then(
      function () {
        var msg = "Copied.";
        if (clearAfterSeconds > 0) {
          msg += " Will try to clear the clipboard in " + clearAfterSeconds + "s.";
          if (clipboardTimer) clearTimeout(clipboardTimer);
          clipboardTimer = setTimeout(function () {
            // Best effort only: browsers may refuse when the page is not focused,
            // and clipboard-history tools may already hold a copy.
            if (document.hasFocus()) navigator.clipboard.writeText("").catch(function () {});
          }, clearAfterSeconds * 1000);
        }
        toast(msg);
      },
      function () {
        toast("Your browser blocked clipboard access. Try again.");
      }
    );
  }

  // ------------------------------------------------------------------
  // Reauthentication modal
  // ------------------------------------------------------------------

  var state = null; // { request, token, expiresAt, method, trigger }
  var expiryTimer = null;
  var busy = false;

  function modalInstance() {
    var el = $("cvReauthModal");
    return el && window.bootstrap ? window.bootstrap.Modal.getOrCreateInstance(el) : null;
  }

  function clearModal() {
    var input = $("cvReauthPassword");
    if (input) {
      input.value = "";
      input.type = "password";
    }
    var toggle = $("cvReauthToggle");
    if (toggle) toggle.setAttribute("aria-pressed", "false");
    $("cvReauthError").textContent = "";
    $("cvReauthExpiry").textContent = "";
    if (expiryTimer) clearInterval(expiryTimer);
    expiryTimer = null;
  }

  function setExpiryCountdown() {
    if (expiryTimer) clearInterval(expiryTimer);
    var el = $("cvReauthExpiry");
    var update = function () {
      if (!state || !state.token) {
        el.textContent = "";
        return;
      }
      var left = Math.round((state.expiresAt - Date.now()) / 1000);
      if (left <= 0) {
        state.token = null; // a new challenge is requested on submit
        el.textContent = "This verification window expired. Submitting will start a new one.";
      } else {
        el.textContent = "This verification is valid for " + left + "s.";
      }
    };
    update();
    expiryTimer = setInterval(update, 1000);
  }

  function requestChallenge(request) {
    return postJson(BASE + "/api/challenges", request).then(function (res) {
      if (!res.ok) {
        var err = new Error(res.data.message || "Could not start verification.");
        err.code = res.data.code;
        throw err;
      }
      return res.data;
    });
  }

  function applyChallenge(challenge) {
    state.token = challenge.challengeToken;
    state.method = challenge.method;
    state.expiresAt = Date.now() + challenge.expiresInSeconds * 1000 - 1000;
    $("cvReauthCredential").textContent = challenge.credentialName;
    $("cvReauthAction").textContent =
      (ACTION_LABELS[state.request.action] || "Access") + (state.label ? ": " + state.label : "");
    var input = $("cvReauthPassword");
    if (challenge.method === "account_password") {
      $("cvReauthLabel").textContent = "Your Zander password";
      $("cvReauthHelp").textContent = "The password you sign in to Zander with.";
      input.setAttribute("autocomplete", "current-password");
    } else {
      $("cvReauthLabel").textContent = "Your vault password";
      $("cvReauthHelp").textContent = "Your dedicated credential vault password.";
      input.setAttribute("autocomplete", "off");
    }
    var submit = $("cvReauthSubmit");
    submit.textContent = state.request.action === "copy" ? "Verify and copy" : state.request.action === "restore_version" ? "Verify and restore" : "Verify and reveal";
    setExpiryCountdown();
  }

  function startFlow(trigger) {
    if (busy) return;
    var request = {
      credentialId: Number(trigger.getAttribute("data-credential-id")),
      action: trigger.getAttribute("data-cv-action"),
      field: trigger.getAttribute("data-field"),
      versionId: trigger.getAttribute("data-version-id") ? Number(trigger.getAttribute("data-version-id")) : null,
    };
    busy = true;
    trigger.disabled = true;
    requestChallenge(request)
      .then(function (challenge) {
        state = {
          request: request,
          trigger: trigger,
          label: trigger.getAttribute("data-label") || "",
          target: trigger.getAttribute("data-target"),
          mask: trigger.getAttribute("data-mask"),
        };
        clearModal();
        applyChallenge(challenge);
        var m = modalInstance();
        if (m) m.show();
      })
      .catch(function (err) {
        if (err.code === "enrolment_required") {
          toast("Set your vault password first (Security tab).");
          setTimeout(function () {
            window.location.href = BASE + "/security";
          }, 1200);
        } else {
          toast(err.message);
        }
      })
      .then(function () {
        busy = false;
        trigger.disabled = false;
      });
  }

  function onVerified(result) {
    var request = state.request;
    var target = state.target;
    var mask = state.mask;
    var m = modalInstance();
    if (m) m.hide();
    if (request.action === "copy") {
      copyValue(result.value, Number(result.clipboardClearSeconds) || 0);
    } else if (request.action === "restore_version") {
      toast("Version restored.");
      setTimeout(function () {
        window.location.reload();
      }, 600);
    } else if (target) {
      showSecret(target, mask, result.value, result.revealSeconds);
    }
    result.value = null;
  }

  function submitVerification(event) {
    event.preventDefault();
    if (busy || !state) return;
    var input = $("cvReauthPassword");
    var password = input.value;
    input.value = "";
    if (!password) {
      $("cvReauthError").textContent = "Enter your password.";
      input.focus();
      return;
    }
    busy = true;
    var submit = $("cvReauthSubmit");
    var keepDisabled = false;
    submit.disabled = true;
    $("cvReauthError").textContent = "";

    var ready = state.token && Date.now() < state.expiresAt ? Promise.resolve() : requestChallenge(state.request).then(applyChallenge);
    ready
      .then(function () {
        var token = state.token;
        state.token = null; // single use, whatever the outcome
        return postJson(BASE + "/api/challenges/verify", { challengeToken: token, password: password });
      })
      .then(function (res) {
        password = null;
        if (res.ok) {
          onVerified(res.data);
          return;
        }
        var msg = res.data.message || "Verification failed.";
        $("cvReauthError").textContent = msg;
        if (res.data.code === "locked" || res.status === 404 || res.status === 403) {
          keepDisabled = true; // retrying cannot succeed; the user has to close the dialog
          return;
        }
        input.focus();
      })
      .catch(function (err) {
        password = null;
        $("cvReauthError").textContent = err.message || "Verification failed.";
      })
      .then(function () {
        busy = false;
        submit.disabled = keepDisabled;
      });
  }

  function initModal() {
    var modalEl = $("cvReauthModal");
    if (!modalEl) return;
    $("cvReauthForm").addEventListener("submit", submitVerification);
    modalEl.addEventListener("shown.bs.modal", function () {
      $("cvReauthPassword").focus();
    });
    modalEl.addEventListener("hidden.bs.modal", function () {
      clearModal();
      $("cvReauthSubmit").disabled = false;
      if (state && state.trigger) state.trigger.focus();
      state = null; // drop the token: the next action starts over
    });
    $("cvReauthToggle").addEventListener("click", function () {
      var input = $("cvReauthPassword");
      var show = input.type === "password";
      input.type = show ? "text" : "password";
      this.setAttribute("aria-pressed", String(show));
      this.setAttribute("aria-label", show ? "Hide password" : "Show password");
    });
  }

  // ------------------------------------------------------------------
  // Password generator (create/edit form)
  // ------------------------------------------------------------------

  function randomInt(max) {
    // Rejection sampling: uniform over [0, max) from crypto.getRandomValues.
    var limit = Math.floor(0x100000000 / max) * max;
    var buf = new Uint32Array(1);
    do {
      crypto.getRandomValues(buf);
    } while (buf[0] >= limit);
    return buf[0] % max;
  }

  function generatePassword() {
    var length = Math.min(128, Math.max(8, Number($("g-length").value) || 24));
    var avoid = $("g-ambiguous").checked;
    var sets = [];
    if ($("g-upper").checked) sets.push("ABCDEFGHIJKLMNOPQRSTUVWXYZ");
    if ($("g-lower").checked) sets.push("abcdefghijklmnopqrstuvwxyz");
    if ($("g-digits").checked) sets.push("0123456789");
    if ($("g-symbols").checked) sets.push("!@#$%^&*()-_=+[]{};:,.?/~");
    if (!sets.length) sets.push("abcdefghijklmnopqrstuvwxyz");
    if (avoid) {
      sets = sets.map(function (s) {
        return s.replace(/[Il1O0o]/g, "");
      });
    }
    var all = sets.join("");
    var chars = sets.map(function (s) {
      return s[randomInt(s.length)];
    });
    while (chars.length < length) chars.push(all[randomInt(all.length)]);
    for (var i = chars.length - 1; i > 0; i -= 1) {
      var j = randomInt(i + 1);
      var tmp = chars[i];
      chars[i] = chars[j];
      chars[j] = tmp;
    }
    return chars.join("");
  }

  function initForm() {
    var form = $("cvCredentialForm");
    if (!form) return;
    var generatorTarget = null;

    form.addEventListener("click", function (event) {
      var toggle = event.target.closest("[data-cv-toggle]");
      if (toggle) {
        var input = $(toggle.getAttribute("data-cv-toggle"));
        input.type = input.type === "password" ? "text" : "password";
        return;
      }
      var gen = event.target.closest("[data-cv-generate]");
      if (gen) {
        generatorTarget = gen.getAttribute("data-cv-generate");
        var panel = $("cvGenerator");
        panel.hidden = !panel.hidden;
        return;
      }
      var remove = event.target.closest("[data-cv-remove-row]");
      if (remove) {
        remove.closest(".cv-custom-row").remove();
      }
    });

    var apply = $("g-apply");
    if (apply) {
      apply.addEventListener("click", function () {
        if (!generatorTarget) return;
        var input = $(generatorTarget);
        input.value = generatePassword();
        input.type = "text";
        $("cvGenerator").hidden = true;
        input.focus();
      });
    }

    var add = $("cvAddCustom");
    if (add) {
      add.addEventListener("click", function () {
        var tpl = $("cvCustomTemplate");
        $("cvCustomFields").appendChild(tpl.content.cloneNode(true));
      });
    }

    // Secret flags are posted as the row's position, so number them at submit
    // time (rows can be added and removed in any order).
    form.addEventListener("submit", function () {
      form.querySelectorAll("input[data-cv-generated-flag]").forEach(function (el) {
        el.remove();
      });
      form.querySelectorAll(".cv-custom-row").forEach(function (row, index) {
        var box = row.querySelector(".cv-custom-secret");
        if (box && box.checked) {
          var hidden = document.createElement("input");
          hidden.type = "hidden";
          hidden.name = "custom_secret";
          hidden.value = String(index);
          hidden.setAttribute("data-cv-generated-flag", "1");
          form.appendChild(hidden);
        }
      });
    });

    // A new secret custom field should mask its value as it is typed.
    $("cvCustomFields").addEventListener("change", function (event) {
      if (!event.target.classList.contains("cv-custom-secret")) return;
      var value = event.target.closest(".cv-custom-row").querySelector('[name="custom_value"]');
      value.type = event.target.checked ? "password" : "text";
      value.setAttribute("autocomplete", event.target.checked ? "new-password" : "off");
    });
  }

  // ------------------------------------------------------------------
  // Page wiring
  // ------------------------------------------------------------------

  document.addEventListener("click", function (event) {
    var trigger = event.target.closest("[data-cv-action]");
    if (trigger) {
      event.preventDefault();
      startFlow(trigger);
      return;
    }
    var hide = event.target.closest("[data-cv-hide]");
    if (hide) {
      hideSecret(hide.getAttribute("data-cv-hide"));
      return;
    }
    var plainInput = event.target.closest("[data-cv-copy-plain-input]");
    if (plainInput) {
      var field = $(plainInput.getAttribute("data-cv-copy-plain-input"));
      if (field && navigator.clipboard) {
        navigator.clipboard.writeText(field.value).then(function () { toast("Copied."); }, function () { toast("Your browser blocked clipboard access."); });
      }
      return;
    }
    var plain = event.target.closest("[data-cv-copy-plain]");
    if (plain) {
      var el = $(plain.getAttribute("data-cv-copy-plain"));
      if (el && navigator.clipboard) {
        navigator.clipboard.writeText(el.textContent).then(
          function () {
            toast("Copied.");
          },
          function () {
            toast("Your browser blocked clipboard access.");
          }
        );
      }
    }
  });

  document.addEventListener("submit", function (event) {
    var form = event.target;
    var message = form.getAttribute && form.getAttribute("data-cv-confirm");
    if (message && !window.confirm(message)) event.preventDefault();
  });

  document.addEventListener("change", function (event) {
    if (!event.target.matches("[data-cv-principal]")) return;
    var form = event.target.closest("form");
    var isGroup = event.target.value === "group";
    form.querySelector("[data-cv-principal-user]").hidden = isGroup;
    form.querySelector("[data-cv-principal-group]").hidden = !isGroup;
  });

  initModal();
  initForm();
})();
