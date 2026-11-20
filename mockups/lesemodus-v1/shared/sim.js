/* Nur Plan-Mockup: der Terminal-Simulator fehlt in diesem Baum. Ein stiller
   Platzhalter genügt — hier geht es nur um die Einstellungen. */
(function () {
  var noop = new Proxy(function () {}, {
    get: function (t, k) { return k === Symbol.toPrimitive ? function () { return ''; } : k === 'then' ? undefined : k === 'length' ? 0 : k === Symbol.iterator ? function* () {} : noop; },
    apply: function () { return noop; },
  });
  window.TMSSim = noop;
})();
