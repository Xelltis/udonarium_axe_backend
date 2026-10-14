import { Hono } from 'hono';

import { assetRoutes } from './assets/routes';

const app = new Hono<{ Bindings: Env }>();

app.get('/', (c) => c.json({ message: 'Hello udonarium-axe-backend!' }));
app.route('/v1/assets', assetRoutes);

export default app;
