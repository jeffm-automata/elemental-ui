import { IClusterProvisioner, ClusterProvisionerContext } from '@shell/core/types';
import CreateCluster from './components/CreateCluster.vue';

/**
 * Card on Cluster Management > Create for Elemental 3 clusters on Harvester.
 *
 * The card opens this extension's own form (`component`). It does not use Rancher's RKE2 form: the
 * cluster is a set of upstream Cluster API objects that Rancher Turtles imports, not a
 * provisioning.cattle.io cluster.
 */
export class Elemental3HarvesterProvisioner implements IClusterProvisioner {
  static ID = 'elemental3-harvester';

  // eslint-disable-next-line no-useless-constructor
  constructor(private context: ClusterProvisionerContext) {}

  get id(): string {
    return Elemental3HarvesterProvisioner.ID;
  }

  get icon(): any {
    return require('./assets/elemental3.svg');
  }

  // Same group as the node-driver cards ("Provision new nodes and create a cluster using RKE2/K3s")
  get group(): string {
    return 'rke2';
  }

  get label(): string {
    return this.context.t('elemental3.provisioner.label');
  }

  get description(): string {
    return this.context.t('elemental3.provisioner.description');
  }

  get tag(): string {
    return this.context.t('elemental3.provisioner.tag');
  }

  get component(): any {
    return CreateCluster;
  }

  get detailTabs(): any {
    return {
      machines:     false,
      logs:         false,
      registration: false,
      snapshots:    false,
      related:      true,
      events:       true,
      conditions:   true,
    };
  }
}
