// Where the Triage API lives. '' = same origin (when FastAPI serves this folder).
// For a static deploy (GitHub Pages / S3), set the deployed API URL, e.g.
//   window.TRIAGE_API_BASE = 'https://triage-api.onrender.com';
// Leave it unset and the app runs in offline mode: everything works except DNS/MX checks and saved lists.
window.TRIAGE_API_BASE = window.TRIAGE_API_BASE || '';
