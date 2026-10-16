import { rootRoute } from '../../../src/http/routes/root.js';

describe('rootRoute', () => {
  it('GET / returns hello JSON', async () => {
    const res = await rootRoute.request(new Request('http://localhost/'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: 'Hello udonarium-backend-vercel!' });
  });
});
