import { statusRoute } from '../../../../src/http/routes/v1/status.js';

describe('statusRoute', () => {
  it('GET /status returns plain OK', async () => {
    const res = await statusRoute.request(new Request('http://localhost/status'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('OK');
  });
});
