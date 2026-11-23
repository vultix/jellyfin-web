import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getWebOSPlaybackRate, isWebOSPlaybackRateSupported, setWebOSPlaybackRate } from './webOSPlaybackRate';

/** What happened, in order: service calls and seeks */
let log: string[];
let setPlayRateParams: object[];

class FakeBridge {
    onservicecallback: ((message: string) => void) | null = null;

    call(uri: string, params: string) {
        const method = uri.split('/').pop();
        log.push(method ?? uri);
        const reply = (message: object) => setTimeout(() => this.onservicecallback?.(JSON.stringify(message)), 10);
        if (method === 'setPlayRate') {
            setPlayRateParams.push(JSON.parse(params));
            reply({ returnValue: true });
        } else if (method === 'subscribe') {
            reply({ subscription: true });
            reply({ seekDone: { mediaId: JSON.parse(params).mediaId } });
        }
    }

    cancel() { /* nothing to cancel */ }
}

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

describe('webOSPlaybackRate', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        log = [];
        setPlayRateParams = [];
        window.PalmServiceBridge = FakeBridge;
    });

    afterEach(() => {
        vi.useRealTimers();
        delete window.PalmServiceBridge;
    });

    it('is supported only with a service bridge', () => {
        expect(isWebOSPlaybackRateSupported()).toBe(true);
        delete window.PalmServiceBridge;
        expect(isWebOSPlaybackRateSupported()).toBe(false);
    });

    it('sets the element rate and keeps the sound with setPlayRate', async () => {
        const element = createElement('pipeline-1');

        const done = setWebOSPlaybackRate(element, 1.5);
        await vi.runAllTimersAsync();
        await done;

        expect(element.playbackRate).toBe(1.5);
        expect(log).toEqual(['setPlayRate']);
        expect(setPlayRateParams).toEqual([{ mediaId: 'pipeline-1', playRate: 1.5, audioOutput: true }]);
    });

    it('seeks in place before changing the rate of the same pipeline again', async () => {
        const element = createElement('pipeline-1');

        const first = setWebOSPlaybackRate(element, 1.5);
        await vi.runAllTimersAsync();
        await first;
        const second = setWebOSPlaybackRate(element, 2);
        await vi.runAllTimersAsync();
        await second;

        expect(log).toEqual(['setPlayRate', 'subscribe', 'seek 42', 'setPlayRate']);
        expect(element.playbackRate).toBe(2);
    });

    it('does not seek on a new pipeline', async () => {
        const element = createElement('pipeline-1');

        const first = setWebOSPlaybackRate(element, 1.5);
        await vi.runAllTimersAsync();
        await first;
        element.mediaId = 'pipeline-2';
        const second = setWebOSPlaybackRate(element, 1.5);
        await vi.runAllTimersAsync();
        await second;

        expect(log).toEqual(['setPlayRate', 'setPlayRate']);
    });

    it('waits for the pipeline to start', async () => {
        const element = createElement();

        const done = setWebOSPlaybackRate(element, 2);
        await vi.advanceTimersByTimeAsync(1000);
        element.mediaId = 'pipeline-1';
        await vi.runAllTimersAsync();
        await done;

        expect(setPlayRateParams).toEqual([{ mediaId: 'pipeline-1', playRate: 2, audioOutput: true }]);
    });

    it('falls back to the element rate when the pipeline never starts', async () => {
        const element = createElement();

        const done = setWebOSPlaybackRate(element, 2);
        await vi.runAllTimersAsync();
        await done;

        expect(element.playbackRate).toBe(2);
        expect(log).toEqual([]);
    });

    it('applies only the latest of several quick changes', async () => {
        const element = createElement();

        const first = setWebOSPlaybackRate(element, 1.25);
        const second = setWebOSPlaybackRate(element, 1.5);
        const third = setWebOSPlaybackRate(element, 2);
        expect(getWebOSPlaybackRate(element)).toBe(2);
        element.mediaId = 'pipeline-1';
        await vi.runAllTimersAsync();
        await Promise.all([first, second, third]);

        expect(setPlayRateParams).toEqual([{ mediaId: 'pipeline-1', playRate: 2, audioOutput: true }]);
        expect(element.playbackRate).toBe(2);
        expect(getWebOSPlaybackRate(element)).toBeUndefined();
    });

    it('needs no service call for 1x on an unchanged pipeline', async () => {
        const element = createElement('pipeline-1');

        const done = setWebOSPlaybackRate(element, 1);
        await vi.runAllTimersAsync();
        await done;

        expect(log).toEqual([]);
        expect(element.playbackRate).toBe(1);
    });

    it('goes back to 1x through the media service after a change', async () => {
        const element = createElement('pipeline-1');

        const first = setWebOSPlaybackRate(element, 2);
        await vi.runAllTimersAsync();
        await first;
        const second = setWebOSPlaybackRate(element, 1);
        await vi.runAllTimersAsync();
        await second;

        expect(log).toEqual(['setPlayRate', 'subscribe', 'seek 42', 'setPlayRate']);
        expect(setPlayRateParams[1]).toEqual({ mediaId: 'pipeline-1', playRate: 1, audioOutput: true });
    });
});
