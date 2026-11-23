import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    cancelWebOSPlaybackRate,
    getWebOSPlaybackRate,
    setWebOSPlaybackRate
} from './webOSPlaybackRate';

/** Service calls and seeks, in order */
let log: string[];
let bridges: FakeBridge[];

class FakeBridge {
    onservicecallback: ((message: string) => void) | null = null;
    method = '';
    params: Record<string, unknown> = {};
    cancelled = false;

    constructor() {
        bridges.push(this);
    }

    call(uri: string, params: string) {
        this.method = uri.split('/').pop() ?? uri;
        this.params = JSON.parse(params);
        log.push(this.method);
        if (this.method === 'setPlayRate') {
            setTimeout(() => this.emit({ returnValue: true }), 10);
        }
    }

    cancel() {
        this.cancelled = true;
    }

    emit(message: object) {
        this.onservicecallback?.(JSON.stringify(message));
    }
}

const subscriptions = () => bridges.filter(bridge => bridge.method === 'subscribe');
const playRates = () => bridges.filter(bridge => bridge.method === 'setPlayRate').map(bridge => bridge.params);

function createElement(mediaId?: string) {
    let position = 42;
    return {
        playbackRate: 1,
        mediaId,
        get currentTime() { return position; },
        set currentTime(value: number) {
            log.push(`seek ${value}`);
            position = value;
        }
    } as unknown as HTMLMediaElement;
}

async function setRate(element: HTMLMediaElement, rate: number) {
    setWebOSPlaybackRate(element, rate);
    await vi.advanceTimersByTimeAsync(100);
}

describe('webOSPlaybackRate', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        log = [];
        bridges = [];
        window.PalmServiceBridge = FakeBridge;
    });

    afterEach(() => {
        vi.useRealTimers();
        delete window.PalmServiceBridge;
    });

    it('sets the element rate and keeps the sound with setPlayRate', async () => {
        const element = createElement('pipeline-1');

        await setRate(element, 1.5);

        expect(element.playbackRate).toBe(1.5);
        expect(log).toEqual(['setPlayRate']);
        expect(playRates()).toEqual([{ mediaId: 'pipeline-1', playRate: 1.5, audioOutput: true }]);
        expect(getWebOSPlaybackRate(element)).toBeUndefined();
    });

    it('waits for an in-place seek before changing the same pipeline again', async () => {
        const element = createElement('pipeline-1');
        await setRate(element, 1.5);

        await setRate(element, 2);
        expect(log).toEqual(['setPlayRate', 'subscribe', 'seek 42']);
        expect(element.playbackRate).toBe(1.5);
        expect(getWebOSPlaybackRate(element)).toBe(2);

        subscriptions()[0].emit({ seekDone: { mediaId: 'pipeline-1' } });
        await vi.advanceTimersByTimeAsync(100);

        expect(log).toEqual(['setPlayRate', 'subscribe', 'seek 42', 'setPlayRate']);
        expect(element.playbackRate).toBe(2);
        expect(subscriptions()[0].cancelled).toBe(true);
    });

    it.each([
        ['times out', () => vi.advanceTimersByTimeAsync(2000)],
        ['is refused', () => {
            subscriptions()[0].emit({ returnValue: false });
            return vi.advanceTimersByTimeAsync(10);
        }]
    ])('leaves the rate alone when the seek %s', async (_, endSeek) => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const element = createElement('pipeline-1');
        await setRate(element, 1.5);

        await setRate(element, 2);
        await endSeek();

        expect(playRates()).toHaveLength(1);
        expect(element.playbackRate).toBe(1.5);
        expect(subscriptions()[0].cancelled).toBe(true);
        expect(getWebOSPlaybackRate(element)).toBeUndefined();
        expect(warn).toHaveBeenCalled();
    });

    it('applies the rate to the new pipeline when it is replaced during the seek', async () => {
        const element = createElement('pipeline-1');
        await setRate(element, 1.5);

        await setRate(element, 2);
        element.mediaId = 'pipeline-2';
        subscriptions()[0].emit({ seekDone: { mediaId: 'pipeline-1' } });
        await vi.advanceTimersByTimeAsync(100);

        expect(playRates()[1]).toEqual({ mediaId: 'pipeline-2', playRate: 2, audioOutput: true });
        expect(subscriptions()).toHaveLength(1);
        expect(element.playbackRate).toBe(2);
    });

    it('does not seek on a new pipeline', async () => {
        const element = createElement('pipeline-1');
        await setRate(element, 1.5);

        element.mediaId = 'pipeline-2';
        await setRate(element, 1.5);

        expect(log).toEqual(['setPlayRate', 'setPlayRate']);
    });

    it('waits for the pipeline to start', async () => {
        const element = createElement();

        setWebOSPlaybackRate(element, 2);
        await vi.advanceTimersByTimeAsync(1000);
        element.mediaId = 'pipeline-1';
        await vi.advanceTimersByTimeAsync(500);

        expect(playRates()).toEqual([{ mediaId: 'pipeline-1', playRate: 2, audioOutput: true }]);
    });

    it('falls back to the element rate within the timeout, however many changes were queued', async () => {
        const element = createElement();

        setWebOSPlaybackRate(element, 1.25);
        await vi.advanceTimersByTimeAsync(1000);
        setWebOSPlaybackRate(element, 1.5);
        setWebOSPlaybackRate(element, 2);
        await vi.advanceTimersByTimeAsync(10_500);

        expect(element.playbackRate).toBe(2);
        expect(log).toEqual([]);
    });

    it('applies only the latest of several changes made during a seek', async () => {
        const element = createElement('pipeline-1');
        await setRate(element, 1.5);

        await setRate(element, 2);
        await setRate(element, 1.25);
        subscriptions()[0].emit({ seekDone: {} });
        await vi.advanceTimersByTimeAsync(100);
        subscriptions()[1].emit({ seekDone: {} });
        await vi.advanceTimersByTimeAsync(100);

        expect(playRates().map(params => params.playRate)).toEqual([1.5, 1.25]);
        expect(element.playbackRate).toBe(1.25);
    });

    it('goes back to 1x through the media service only after a change', async () => {
        const element = createElement('pipeline-1');
        await setRate(element, 1);
        expect(log).toEqual([]);

        await setRate(element, 2);
        await setRate(element, 1);
        subscriptions()[0].emit({ seekDone: {} });
        await vi.advanceTimersByTimeAsync(100);

        expect(playRates()[1]).toEqual({ mediaId: 'pipeline-1', playRate: 1, audioOutput: true });
        expect(element.playbackRate).toBe(1);
    });

    it('drops a pending change when cancelled', async () => {
        const element = createElement();

        setWebOSPlaybackRate(element, 2);
        await vi.advanceTimersByTimeAsync(500);
        cancelWebOSPlaybackRate(element);
        element.mediaId = 'pipeline-1';
        await vi.advanceTimersByTimeAsync(11_000);

        expect(log).toEqual([]);
        expect(element.playbackRate).toBe(1);
        expect(getWebOSPlaybackRate(element)).toBeUndefined();
    });
});
