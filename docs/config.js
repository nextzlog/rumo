// Site configuration.  Edit this file before deploying; nothing else needs a change.
//
// Google Form: the report opens the form below with two fields pre-filled.
//   entries.correct  paragraph: what the user actually heard (the user's correction)
//   entries.decoded  paragraph: what the app decoded, then "---", the version,
//                    frequency, WPM and SNR, and "trace: ..." (compact decoder trace)
// To find entry IDs of another form: menu (three dots) > "Get pre-filled link",
// type a marker into each field, press "Get link" and read the entry.NNN keys.
// Leave formUrl empty to hide the form link (the report can still be copied).
window.RUMO_CONFIG = {
  formUrl: "https://docs.google.com/forms/d/e/1FAIpQLSdd0a6gR6UnUj-Pha7QB_hWiSH-wLr3gpqtA1uMpK9QSjTJWw/viewform",
  entries: {
    correct: "entry.1729264046",
    decoded: "entry.1051749941",
  },
  // Longest pre-filled URL to open directly; longer reports are copied for pasting instead.
  maxUrlLength: 7000,
  // Seconds of decoder trace attached to a report.
  traceSeconds: 60,
  // The live decoder drops the oldest audio when it falls this far behind real time.
  maxLagSec: 20,
  // Frequency range of the waterfall (Hz).
  bandLo: 250,
  bandHi: 1300,
};
