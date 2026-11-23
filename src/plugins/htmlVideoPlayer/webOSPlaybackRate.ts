// Playback speed on webOS.
//
// Changing only the element's playbackRate makes the webOS media pipeline mute the
// sound. Following it with the media service's setPlayRate (audioOutput: true)
// keeps the sound on. A pipeline accepts this once; a later change is ignored
// unless a seek has completed since, so later changes seek in place first.

interface ServiceBridge {
    onservicecallback: ((message: string) => void) | null;
    call(uri: string, params: string): void;
    cancel(): void;
}

interface ServiceReply {
    returnValue?: boolean;
    seekDone?: unknown;
}

declare global {
    interface Window {
        PalmServiceBridge?: new () => ServiceBridge;
    }
    interface HTMLMediaElement {
        /** Set by webOS once the media pipeline has started */
        mediaId?: string;
    }
}

const MEDIA_SERVICE = 'luna://com.webos.media/';
const CALL_TIMEOUT_MS = 5000;
const SEEK_TIMEOUT_MS = 2000;
const MEDIA_ID_TIMEOUT_MS = 10000;
const MEDIA_ID_POLL_MS = 250;

/** Rate of a change still being applied, per element */
const pendingRates = new WeakMap<HTMLMediaElement, number>();
/** Request counter per element, so a superseded change stops early */
const requestIds = new WeakMap<HTMLMediaElement, number>();
/** Changes run one at a time per element */
const queues = new WeakMap<HTMLMediaElement, Promise<void>>();
/** mediaId of the pipeline whose rate was last changed, per element */
const changedPipelines = new WeakMap<HTMLMediaElement, string>();

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export function isWebOSPlaybackRateSupported(): boolean {
    return typeof window.PalmServiceBridge === 'function';
}

function callService(method: string, params: object): Promise<ServiceReply> {
    return new Promise(resolve => {
        const Bridge = window.PalmServiceBridge;
        if (!Bridge) {
            resolve({ returnValue: false });
            return;
        }
        const bridge = new Bridge();
        const timer = setTimeout(() => finish({ returnValue: false }), CALL_TIMEOUT_MS);
        function finish(reply: ServiceReply) {
            clearTimeout(timer);
            bridge.onservicecallback = null;
            resolve(reply);
        }
        bridge.onservicecallback = message => {
            try {
                finish(JSON.parse(message));
            } catch {
                finish({ returnValue: false });
            }
        };
        bridge.call(MEDIA_SERVICE + method, JSON.stringify(params));
    });
}

/** Resolves once the pipeline reports a finished seek, or false after a timeout */
function watchSeekDone(mediaId: string): Promise<boolean> {
    return new Promise(resolve => {
        const Bridge = window.PalmServiceBridge;
        if (!Bridge) {
            resolve(false);
            return;
        }
        const bridge = new Bridge();
        const timer = setTimeout(() => finish(false), SEEK_TIMEOUT_MS);
        function finish(done: boolean) {
            clearTimeout(timer);
            bridge.onservicecallback = null;
            bridge.cancel();
            resolve(done);
        }
        bridge.onservicecallback = message => {
            try {
                if ((JSON.parse(message) as ServiceReply).seekDone) finish(true);
            } catch {
                // ignore unparsable events
            }
        };
        bridge.call(MEDIA_SERVICE + 'subscribe', JSON.stringify({ mediaId, subscribe: true }));
    });
}

/** The mediaId appears a few seconds after a new source starts loading */
async function waitForMediaId(element: HTMLMediaElement): Promise<string | undefined> {
    for (let waited = 0; !element.mediaId && waited < MEDIA_ID_TIMEOUT_MS; waited += MEDIA_ID_POLL_MS) {
        await sleep(MEDIA_ID_POLL_MS);
    }
    return element.mediaId;
}

async function applyRate(element: HTMLMediaElement, rate: number, requestId: number) {
    const isCurrent = () => requestIds.get(element) === requestId;

    const mediaId = await waitForMediaId(element);
    if (!isCurrent()) return;
    if (!mediaId) {
        // Speeds up, but silently
        element.playbackRate = rate;
        return;
    }

    const changed = changedPipelines.get(element) === mediaId;
    if (!changed && rate === 1) {
        element.playbackRate = 1;
        return;
    }

    if (changed) {
        const seekDone = watchSeekDone(mediaId);
        const position = element.currentTime;
        element.currentTime = position;
        await seekDone;
        if (!isCurrent()) return;
    }

    element.playbackRate = rate;
    const reply = await callService('setPlayRate', { mediaId, playRate: rate, audioOutput: true });
    changedPipelines.set(element, mediaId);
    if (!reply.returnValue) {
        console.warn('[webOSPlaybackRate] setPlayRate failed, playback may be muted', reply);
    }
}

/**
 * Change the playback rate on webOS without losing the sound.
 * Resolves once the change is applied, or superseded by a newer one.
 */
export function setWebOSPlaybackRate(element: HTMLMediaElement, rate: number): Promise<void> {
    const requestId = (requestIds.get(element) ?? 0) + 1;
    requestIds.set(element, requestId);
    pendingRates.set(element, rate);

    const run = () => applyRate(element, rate, requestId).finally(() => {
        if (requestIds.get(element) === requestId) pendingRates.delete(element);
    });
    const next = (queues.get(element) ?? Promise.resolve()).then(run, run);
    queues.set(element, next.catch(() => { /* already logged */ }));
    return next;
}

/** The rate of a change still being applied to this element, if any */
export function getWebOSPlaybackRate(element: HTMLMediaElement): number | undefined {
    return pendingRates.get(element);
}
