import { AudioPlayerQueue } from './AudioPlayerQueue';

const mockSound = {
  playAsync: jest.fn(async () => {}),
  pauseAsync: jest.fn(async () => {}),
  unloadAsync: jest.fn(async () => {}),
  setOnPlaybackStatusUpdate: jest.fn(),
};

jest.mock('expo-av', () => ({
  Audio: {
    Sound: {
      createAsync: jest.fn(async () => ({ sound: mockSound })),
    },
  },
}));

describe('AudioPlayerQueue', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('plays chunks sequentially', async () => {
    const q = new AudioPlayerQueue();
    await q.enqueue('base64-a');
    await q.enqueue('base64-b');
    // After 1st finishes, 2nd starts.
    expect(mockSound.playAsync).toHaveBeenCalledTimes(1);
  });

  it('pauses and resumes from current chunk', async () => {
    const q = new AudioPlayerQueue();
    await q.enqueue('base64-a');
    await q.pause();
    expect(mockSound.pauseAsync).toHaveBeenCalled();
    await q.resume();
    expect(mockSound.playAsync).toHaveBeenCalledTimes(2);
  });

  it('clears queue on stop', async () => {
    const q = new AudioPlayerQueue();
    await q.enqueue('base64-a');
    await q.stop();
    expect(q.queueLength()).toBe(0);
  });
});
