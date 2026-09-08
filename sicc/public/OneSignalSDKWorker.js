// Fallback for OneSignal clients that resolve the worker relative to the site root.
// The primary worker lives under push/onesignal/ so it does not overlap the SICC PWA worker.
importScripts("https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js");
