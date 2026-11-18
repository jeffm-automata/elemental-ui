import { importTypes } from '@rancher/auto-import';
import { IPlugin } from '@shell/core/types';
import { Elemental3HarvesterProvisioner } from './provisioner';
import routes from './routes';

// Init the package
export default function(plugin: IPlugin): void {
  // Auto-import l10n (and model, detail, edit if folders are added later)
  importTypes(plugin);

  // Provide plugin metadata from package.json
  plugin.metadata = require('./package.json');

  // Card on Cluster Management > Create, next to the existing provisioners
  plugin.register('provisioner', Elemental3HarvesterProvisioner.ID, Elemental3HarvesterProvisioner);

  // Cluster Management > Elemental 3 Clusters: list, and one page per cluster (progress, pools, release)
  plugin.addProduct(require('./product'));
  plugin.addRoutes(routes);
}
