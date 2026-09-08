export type NotificationPermission = "default" | "granted" | "denied";

export type OneSignalSdk = {
  Notifications: {
    permission?: boolean;
    requestPermission: () => Promise<void>;
  };
  login?: (externalId: string) => Promise<void>;
  logout?: () => Promise<void>;
};

declare global {
  interface Window {
    OneSignalDeferred?: Array<(oneSignal: OneSignalSdk) => void | Promise<void>>;
  }
}

const APP_ID = "6934d3ea-0e2f-4273-8196-6415d4933815";
const SAFARI_WEB_ID = "web.onesignal.auto.1150f274-be67-4412-813c-e6f1ba6adf3e";
const SDK_SRC = "https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.page.js";

let sdkPromise: Promise<OneSignalSdk> | null = null;
let sdkInstance: OneSignalSdk | null = null;

function siteBasePath() {
  return new URL("./", document.baseURI).pathname.replace(/\/$/, "") + "/";
}

function workerConfig() {
  const scope = `${siteBasePath()}push/onesignal/`;
  // OneSignal expects serviceWorkerPath without a leading slash. Keeping the
  // worker in its own scope prevents it from replacing the SICC PWA worker.
  return {
    serviceWorkerPath: `${scope.replace(/^\//, "")}OneSignalSDKWorker.js`,
    serviceWorkerParam: { scope },
  };
}

function loadSdkScript() {
  if (window.OneSignalDeferred) return;
  window.OneSignalDeferred = [];
  const script = document.createElement("script");
  script.src = SDK_SRC;
  script.defer = true;
  document.head.appendChild(script);
}

export function initOneSignal(externalId: string): Promise<OneSignalSdk> {
  if (sdkPromise) return sdkPromise;
  if (typeof window === "undefined" || !window.isSecureContext) {
    return Promise.reject(new Error("OneSignal exige HTTPS ou localhost."));
  }

  loadSdkScript();
  sdkPromise = new Promise<OneSignalSdk>((resolve, reject) => {
    const queue = window.OneSignalDeferred!;
    queue.push(async (oneSignal) => {
      try {
        // init is intentionally non-prompting. The permission request is made
        // only from the visible button in the SICC interface.
        await (oneSignal as OneSignalSdk & { init: (options: Record<string, unknown>) => Promise<void> }).init({
          appId: APP_ID,
          safari_web_id: SAFARI_WEB_ID,
          ...workerConfig(),
          // Do not send OneSignal's generic subscription confirmation. The
          // SICC should notify only about operational QTCs.
          welcomeNotification: { disable: true },
          notifyButton: { enable: false },
        });
        if (oneSignal.login) await oneSignal.login(String(externalId));
        sdkInstance = oneSignal;
        resolve(oneSignal);
      } catch (error) {
        sdkPromise = null;
        reject(error);
      }
    });
    window.setTimeout(() => reject(new Error("Não foi possível carregar o OneSignal.")), 12_000);
  });
  return sdkPromise;
}

export async function requestOneSignalPermission(oneSignal: OneSignalSdk) {
  await oneSignal.Notifications.requestPermission();
  return readOneSignalPermission(oneSignal);
}

export function readOneSignalPermission(oneSignal: OneSignalSdk): NotificationPermission {
  if (oneSignal.Notifications.permission === true) return "granted";
  if (typeof Notification !== "undefined" && Notification.permission === "denied") return "denied";
  return "default";
}

export async function logoutOneSignal() {
  if (sdkInstance?.logout) await sdkInstance.logout();
  sdkInstance = null;
}
