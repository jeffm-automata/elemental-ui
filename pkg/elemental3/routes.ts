import ClusterList from './pages/ClusterList.vue';
import ClusterDetail from './pages/ClusterDetail.vue';
import { BLANK_CLUSTER, DETAIL_ROUTE, LIST_ROUTE, MANAGER_PRODUCT } from './product';

const meta = {
  product: MANAGER_PRODUCT, cluster: BLANK_CLUSTER, pkg: 'elemental3'
};

export default [
  {
    name: LIST_ROUTE, path: '/c/:cluster/manager/elemental3', component: ClusterList, meta
  },
  {
    name: DETAIL_ROUTE, path: '/c/:cluster/manager/elemental3/:namespace/:id', component: ClusterDetail, meta
  },
];
