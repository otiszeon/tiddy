import 'source-map-support/register'
import * as admin from 'firebase-admin';
import { productionComponents } from './ioc/prod';
import { getContainer } from './ioc/components';
import { Container } from 'inversify';
import { baseComponents } from './ioc/base';

export const productionStartup = ():Container => {
  const app = admin.initializeApp();
  const container = getContainer();
  container.load(baseComponents);
  container.load(productionComponents(app));
  return container;
}
