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

interface State {
    rate: number;
    /** A rate was requested that the runner has not picked up yet */
    pending: boolean;
    running: boolean;
    /** The pipeline whose rate was changed last */
    changedMediaId?: string;
}

const MEDIA_SERVICE = 'luna://com.webos.media/';
const CALL_TIMEOUT_MS = 5000;
const SEEK_TIMEOUT_MS = 2000;
// The mediaId appears a few seconds after a new source starts loading
const MEDIA_ID_TIMEOUT_MS = 10000;
const MEDIA_ID_POLL_MS = 250;

const states = new WeakMap<HTMLMediaElement, State>();

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export function isWebOSPlaybackRateSupported(): boolean {
    return typeof window.PalmServiceBridge === 'function';
}

/** Calls a media service method; `onReply` returns true once it has the reply it needs. */
function callService(method: string, params: object, timeoutMs: number, onReply: (reply: ServiceReply) => boolean): Promise<boolean> {
    return new Promise(resolve => {
        const Bridge = window.PalmServiceBridge;
        if (!Bridge) {
            resolve(false);
            return;
        }
        const bridge = new Bridge();
        const timer = setTimeout(() => finish(false), timeoutMs);
        function finish(result: boolean) {
            clearTimeout(timer);
            bridge.onservicecallback = null;
            bridge.cancel();
            resolve(result);
        }
        bridge.onservicecallback = message => {
            let reply: ServiceReply;
            try {
                reply = JSON.parse(message);
            } catch {
                return;
            }
            if (reply.returnValue === false) finish(false);
            else if (onReply(reply)) finish(true);
        };
        bridge.call(MEDIA_SERVICE + method, JSON.stringify(params));
    });
}

function seekInPlace(element: HTMLMediaElement, mediaId: string): Promise<boolean> {
    const seekDone = callService('subscribe', { mediaId, subscribe: true }, SEEK_TIMEOUT_MS, reply => Boolean(reply.seekDone));
    const position = element.currentTime;
    element.currentTime = position;
    return seekDone;
}

async function applyRate(element: HTMLMediaElement, state: State, rate: number) {
    // A newer request, or the player stopping, ends this one
    const superseded = () => state.pending || states.get(element) !== state;

    for (let waited = 0; !element.mediaId && waited < MEDIA_ID_TIMEOUT_MS && !superseded(); waited += MEDIA_ID_POLL_MS) {
        await sleep(MEDIA_ID_POLL_MS);
    }
    if (superseded()) return;

    const mediaId = element.mediaId;
    if (!mediaId) {
        // Speeds up, but silently
        element.playbackRate = rate;
        return;
    }

    const changed = state.changedMediaId === mediaId;
    if (!changed && rate === 1) {
        element.playbackRate = 1;
        return;
    }

    if (changed) {
        const seeked = await seekInPlace(element, mediaId);
        if (superseded()) return;
        if (element.mediaId !== mediaId) {
            // The pipeline was replaced during the seek: start over on the new one
            state.pending = true;
            return;
        }
        if (!seeked) {
            console.warn('[webOSPlaybackRate] seek did not finish, playback rate not changed');
            return;
        }
    }

    element.playbackRate = rate;
    state.changedMediaId = mediaId;
    const ok = await callService('setPlayRate', { mediaId, playRate: rate, audioOutput: true }, CALL_TIMEOUT_MS, () => true);
    if (!ok) {
        console.warn('[webOSPlaybackRate] setPlayRate failed, playback may be muted');
    }
}

async function run(element: HTMLMediaElement, state: State) {
    state.running = true;
    try {
        while (state.pending && states.get(element) === state) {
            state.pending = false;
            await applyRate(element, state, state.rate);
        }
    } catch (err) {
        console.error('[webOSPlaybackRate] failed to change the playback rate', err);
    } finally {
        state.running = false;
    }
}

/** Change the playback rate on webOS without losing the sound. Only the latest of several quick changes is applied. */
export function setWebOSPlaybackRate(element: HTMLMediaElement, rate: number) {
    let state = states.get(element);
    if (!state) {
        state = { rate, pending: false, running: false };
        states.set(element, state);
    }
    state.rate = rate;
    state.pending = true;
    if (!state.running) void run(element, state);
}

/** Drop any change still being applied, e.g. when playback stops */
export function cancelWebOSPlaybackRate(element: HTMLMediaElement) {
    states.delete(element);
}

/** The rate of a change still being applied to this element, if any */
export function getWebOSPlaybackRate(element: HTMLMediaElement): number | undefined {
    const state = states.get(element);
    return state && (state.pending || state.running) ? state.rate : undefined;
}
