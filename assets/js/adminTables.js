/**
 * assets/js/adminTables.js
 *
 * Dashboard tables on phones. Every table in the dashboard content area with a
 * header row gets the `table-stack` class and a data-label on each cell (copied
 * from its column heading). admin.css then shows each row as a stacked card
 * below 576px wide, instead of squeezing inputs to a few characters or cutting
 * columns off. Desktop layout is unchanged.
 *
 * Opt a table out with class="table-no-stack". Rows added later by page
 * scripts are labelled too.
 */
(function () {
  "use strict";

  function headings(table) {
    var head = table.tHead;
    if (!head || !head.rows.length) return null;
    var cells = head.rows[head.rows.length - 1].cells;
    var labels = [];
    for (var i = 0; i < cells.length; i++) {
      var text = (cells[i].textContent || "").replace(/\s+/g, " ").trim();
      for (var span = 0; span < (cells[i].colSpan || 1); span++) labels.push(text);
    }
    return labels;
  }

  function labelRow(row, labels) {
    var col = 0;
    for (var i = 0; i < row.cells.length; i++) {
      var cell = row.cells[i];
      var label = labels[col];
      if (label && cell.tagName === "TD" && !cell.hasAttribute("data-label")) {
        cell.setAttribute("data-label", label);
      }
      col += cell.colSpan || 1;
    }
  }

  function stack(table) {
    if (table.classList.contains("table-no-stack") || table.closest(".modal")) return;
    var labels = headings(table);
    if (!labels) return;
    table.classList.add("table-stack");
    for (var b = 0; b < table.tBodies.length; b++) {
      var rows = table.tBodies[b].rows;
      for (var r = 0; r < rows.length; r++) labelRow(rows[r], labels);
    }
    if (!table.__stackObserver && window.MutationObserver) {
      table.__stackObserver = new MutationObserver(function () {
        var fresh = headings(table);
        if (!fresh) return;
        for (var b2 = 0; b2 < table.tBodies.length; b2++) {
          var rows2 = table.tBodies[b2].rows;
          for (var r2 = 0; r2 < rows2.length; r2++) labelRow(rows2[r2], fresh);
        }
      });
      table.__stackObserver.observe(table, { childList: true, subtree: true });
    }
  }

  function run() {
    var root = document.getElementById("wpbody-content") || document.body;
    var tables = root.querySelectorAll("table");
    for (var i = 0; i < tables.length; i++) stack(tables[i]);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run);
  } else {
    run();
  }

  // Tables a page builds after load (e.g. from a fetch) are picked up too.
  if (window.MutationObserver) {
    var pending = null;
    new MutationObserver(function () {
      if (pending) return;
      pending = setTimeout(function () {
        pending = null;
        run();
      }, 100);
    }).observe(document.documentElement, { childList: true, subtree: true });
  }
})();
