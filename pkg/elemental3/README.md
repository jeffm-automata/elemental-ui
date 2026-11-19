# Elemental 3 cluster provisioning (experimental)

Adds an **Elemental 3** card to Cluster Management > Create in Rancher (>= 2.15). The card opens a form that
creates an RKE2 cluster of Elemental 3 nodes on Harvester VMs through Cluster API. x86-64 only.

The form only writes objects, with the rights of the logged-in user, that can equally be applied with `kubectl`:

| Object | Name |
|---|---|
| `Cluster` (cluster.x-k8s.io/v1beta2), labelled `cluster-api.cattle.io/rancher-auto-import: "true"` | `<name>` |
| `Secret` with the Harvester kubeconfig CAPHV uses, owned by the Cluster | `<name>-harvester-identity` |
| `HarvesterCluster` (infrastructure.cluster.x-k8s.io/v1beta1) | `<name>` |
| `RKE2ControlPlane` (controlplane.cluster.x-k8s.io/v1beta2) | `<name>-cp` |
| `HarvesterMachineTemplate` x 2 | `<name>-cp`, `<name>-worker` |
| `RKE2ConfigTemplate` (bootstrap.cluster.x-k8s.io/v1beta2) | `<name>-worker` |
| `MachineDeployment` | `<name>-md-0` |

Everything after that is done by controllers on the management cluster: Cluster API and Rancher Turtles, the RKE2
provider (CAPRKE2) and the Harvester provider (CAPHV). The extension contains no lifecycle logic.

Needs on the management cluster: Rancher Turtles with Cluster API, CAPRKE2, CAPHV, and create rights on the kinds
above in the chosen namespace. Optional: the Elemental image build operator (`NodeImage`), which lets the user pick
a release instead of a Harvester image plus its Kubernetes version. Needs in Harvester: an Elemental 3 generic node
image, a VM network, an SSH key pair, and for the user the right to create and delete load balancers
(`loadbalancers.loadbalancer.harvesterhci.io`) in the VM namespace.

Control plane address: by default the Harvester provider creates a Harvester load balancer (address by DHCP) and the
form asks for no address (`loadBalancerConfig.ipamType: dhcp` with a listener for RKE2's port 9345, no
`controlPlaneEndpoint`). "Advanced: use a fixed control plane address" writes `ipamType: external`, the typed
endpoint and a kube-vip manifest instead. Both need a Harvester provider that creates the load balancer with a
namespace-scoped identity, publishes node addresses and knows `external` (CAPHV v0.10.1 does not; the fork's
`v0.10.1-e3p1` build does). The form writes no node address script and depends on no helper script.

## The cluster page (since 0.2.0; this section describes 0.4.0)

Cluster Management > Elemental 3 Clusters lists the clusters; a cluster's page shows provisioning progress, the
Elemental release with the upgrade, machine pools, machines, conditions and events. The page reads object status with
the rights of the logged-in user and writes only on a click: the replica count of a pool, the deletion of a worker
`Machine` (Replace), a new `HarvesterMachineTemplate` plus the pool's reference to it (Change size), the cluster's one
`Release` (lifecycle.suse.com/v1alpha1, in the workload cluster, through Rancher's cluster proxy), and the deletion
of the `Cluster`. While an upgrade runs the state reads "Upgrading"; while a control plane node restarts and
Rancher cannot reach the cluster, the page says so and keeps showing the last progress it read.

**Versions shown.** Cluster API keeps the Kubernetes version a cluster was created with; an upgrade in place by the
Lifecycle Manager changes the nodes, not `spec.version`. The header and the pool table therefore show the kubelet
versions of the nodes (from the workload cluster, else from `Machine.status.nodeInfo`) and say when Cluster API
declares another one. "Current release" is `Release.status.version`, else the release the cluster was created from.

**Releases offered for an upgrade.** There is no release catalog yet. The picker lists the releases the management
side already knows: `NodeImage` objects of the image build operator, Harvester images that carry the annotation
`elemental.suse.com/release-manifest`, and the releases other clusters in the namespace were created from; only
newer releases of the same manifest repository name are offered, and a release from another registry names it. A
version, or a whole manifest reference `registry/path/manifest:version`, can always be typed.

**Ready for an upgrade.** Rancher changes an imported cluster for some minutes after it reports it ready: it replaces
the system upgrade controller the release installed with the chart of its setting
`system-upgrade-controller-chart-version`, and installs its node agent with a Plan. An upgrade started before that
fails in cordon and drain until Rancher is done. The release panel reads, with the rights of the cluster's owner:

| Check | Read | Passes when |
|---|---|---|
| Lifecycle Manager | the `Release` API of the workload cluster | it answers (the release installs its Lifecycle Manager a few minutes after the first boot) |
| chart | Rancher setting `system-upgrade-controller-chart-version` (management cluster); `apps.catalog.cattle.io` `cattle-system/system-upgrade-controller` (workload cluster) | the Helm release has the setting's chart version, is `deployed` and carries Rancher's label `catalog.cattle.io/cluster-repo-name` |
| controller | `Deployment` `cattle-system/system-upgrade-controller` | generation observed, every replica updated and available |
| plans | `plans.upgrade.cattle.io` in `cattle-system`, and the nodes | no Plan has nodes in `status.applying`, none has `Complete` other than `True`, and every node a Plan selects carries `plan.upgrade.cattle.io/<plan>` with the Plan's `latestHash` |

One check failing: "not ready yet", and Upgrade stays disabled. Something unreadable, or the right chart version
without Rancher's label: a warning, Upgrade stays possible. The rule is in `lib/release.ts` (`upgradeReadiness`).

## Layout

- `provisioner.ts`: the card (`IClusterProvisioner` with its own `component`)
- `components/CreateCluster.vue`: the form
- `pages/ClusterList.vue`, `pages/ClusterDetail.vue`: the list and the cluster page
- `lib/objects.ts`: form values to objects, validation, the machine size change (no dependencies)
- `lib/harvester.ts`: Harvester and `NodeImage` data to form choices (no dependencies)
- `lib/status.ts`: object status to progress phases, problems, pool and machine rows (no dependencies)
- `lib/release.ts`: the release, upgrade phases, pre-flight, readiness, running versions (no dependencies)

## Build, lint, test

```sh
yarn install --frozen-lockfile
yarn build-pkg elemental3
yarn lint:elemental3
yarn test:elemental3
```
