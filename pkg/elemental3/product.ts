import { IPlugin } from '@shell/core/types';

export const MANAGER_PRODUCT = 'manager';
export const NAV_TYPE = 'elemental3-clusters';
export const LIST_ROUTE = 'c-cluster-manager-elemental3';
export const DETAIL_ROUTE = 'c-cluster-manager-elemental3-namespace-id';
export const BLANK_CLUSTER = '_';

/** Adds "Elemental 3 Clusters" to the side menu of Cluster Management. */
export function init($plugin: IPlugin, store: any) {
  const { virtualType, basicType, weightType } = $plugin.DSL(store, MANAGER_PRODUCT);

  // `group` is used by Rancher's own manager product for its side menu entries; the published type lacks it
  virtualType({
    name:       NAV_TYPE,
    labelKey:   'elemental3.nav',
    group:      'Root',
    namespaced: false,
    icon:       'os-management',
    route:      { name: LIST_ROUTE, params: { cluster: BLANK_CLUSTER } },
    exact:      false,
  } as any);
  basicType([NAV_TYPE]);
  // Directly under "Clusters"
  weightType(NAV_TYPE, 99.5, true);
}
