import { runPipeline } from '../src/pipeline';

describe('runPipeline', () => {
  it('returns an empty array when given no companies', async () => {
    await expect(runPipeline([], false)).resolves.toEqual([]);
    await expect(runPipeline([], false, { sequential: true })).resolves.toEqual([]);
  });
});
