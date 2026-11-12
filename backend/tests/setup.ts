import { setForceMongoReadyInTests } from '../src/config/mongodb.js';
import { beforeEach } from 'vitest';

setForceMongoReadyInTests(true);

beforeEach(() => {
  setForceMongoReadyInTests(true);
});
