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
| `MachineHealthCheck` for the worker pool, unless switched off in the form | `<name>-md-0-auto-replace` |

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

**Releases offered for an upgrade.** The picker reads the release catalog of the management cluster first:
`AvailableRelease` objects (`lifecycle.suse.com/v1alpha1`, cluster-scoped, written by the catalog controller of the
Lifecycle Manager from the OCI repositories named by `ReleaseSource` objects). Each entry shows the version, the
Kubernetes and operating system versions its manifest states, and "last known, source not reachable" when the
catalog marks it stale. Offered: a higher version of the same lineage (the name the manifest states; the lineage of
the current release is looked up in the catalog, and where the catalog does not hold it the manifest repository
name is compared instead). What is not offered is listed with a one-line reason. Needs `list` on
`availablereleases.lifecycle.suse.com`. Where the catalog is not installed (HTTP 404), not readable (403) or empty,
the picker lists what it listed before the catalog existed, and says so in one line: `NodeImage` objects of the
image build operator, Harvester images that carry the annotation `elemental.suse.com/release-manifest`, and the
releases other clusters in the namespace were created from. A version, or a whole manifest reference
`registry/path/manifest:version`, can always be typed. The rules are in `lib/catalog.ts` and `lib/release.ts`
(`offeredReleases`).

Since 0.5.1: an entry reads `version · [last known ·] Kubernetes …, OS … [· source <name>]`
(the catalog source is named when the release comes from another repository than the current one; the repository
itself is shown under the picker for the selected release, with a warning when that entry is stale). Nothing is
selected by default; the list is ordered highest first, so the first entry is the newest release the cluster can
reach. The catalog is read again once a minute. "Higher" is decided exactly as the Lifecycle Manager's admission
webhook decides it (`compareVersions` in `lib/release.ts`, a port of `version.Parse(new).Compare(applied)` of
`k8s.io/apimachinery/pkg/util/version`), which is not semantic version precedence: a numeric field against a
non-numeric one is compared as text, so `1.37.2-26.4` is higher than `1.37.2-26.3-e3p.1` and `1.37.2-26.10` is
lower, and the order is not transitive. `lib/__tests__/webhook-order.json` is a table printed by the webhook's own
function; the unit tests replay all of it.

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

## Manage controls on the cluster page (since 0.6.0)

All of them write objects a user could apply with `kubectl`, with the rights of the logged-in user; the rules are
in `lib/manage.ts`. x86-64 only, tried on Harvester VMs only.

| Control | Where | What is written |
|---|---|---|
| **Automatic replacement** of a failed worker machine | Create form: on by default (one box). Cluster page, under the pool table: on with a number of minutes, or off | One `MachineHealthCheck` `<pool>-auto-replace` for the worker pool: node `Ready` false or unknown for the minutes (default 5), 30 minutes for a new machine to become a node, no limit on unhealthy machines. Off deletes it. Control plane machines are not selected |
| **Node labels** of a worker pool | Under the pool table: Edit labels | One new `RKE2ConfigTemplate` (the pool's with `agentConfig.nodeLabels` replaced) and the pool's `bootstrap.configRef.name`. Cluster API replaces the pool's machines one by one. Keys under `kubernetes.io` and `k8s.io` are refused in the form |
| **Rotate certificates** | Header | Workers: `spec.rollout.after` on the MachineDeployment. Control plane: the node annotation `elemental.suse.com/certificates-rotated` in `agentConfig.nodeAnnotations` of the RKE2ControlPlane (it has no `rolloutAfter`; a changed bootstrap configuration is what makes the RKE2 provider replace its machines). Every replaced node gets new certificates from the cluster's authorities when it joins; the authorities stay. The form estimates when the oldest certificates run out (the day the oldest node joined plus 365 days; the certificates themselves cannot be read through an API). The page counts replaced machines. Not offered while an upgrade runs, and not on a cluster that was upgraded in place (the machine templates still name the image it was created from) |
| **Download kubeconfig**, **Members**, **Projects** | Header, once Rancher has imported the cluster | Nothing by this extension: Rancher's own kubeconfig for the imported cluster and Rancher's own pages for cluster members and for projects and namespaces |
| **Snapshots** tab: list | Tab | Reads `etcdsnapshotfiles.k3s.cattle.io` in the workload cluster through Rancher's proxy |
| **Snapshots** tab: schedule, retention, S3 target | Change schedule | `serverConfig.etcd.backupConfig` of the RKE2ControlPlane (`scheduleCron`, `retention`, `s3`), and for S3 one Secret with the two keys, owned by the Cluster. The RKE2 provider replaces the control plane machines to apply it |
| **Snapshots** tab: Snapshot now | Button | One `Job` in `kube-system` of the workload cluster: a privileged pod on a control plane node that enters the host's namespaces and runs the node's own `rke2 etcd-snapshot save --name on-demand`. This is the one place where the page starts work on a node itself: Cluster API and the RKE2 provider have no object for a snapshot on request. The Job removes itself an hour after it finished |

Snapshots that exist only as files on control plane nodes are deleted when those machines are replaced (a schedule
change, a certificate rotation): seen in the lab, and the two forms say how many would be lost (since 0.6.2).

Not built: restoring a snapshot, certificate expiry dates read from the certificates, rotation in place, labels and size of the control plane
pool, chart values.

## Layout

- `provisioner.ts`: the card (`IClusterProvisioner` with its own `component`)
- `components/CreateCluster.vue`: the form
- `pages/ClusterList.vue`, `pages/ClusterDetail.vue`: the list and the cluster page
- `lib/objects.ts`: form values to objects, validation, the machine size change (no dependencies)
- `lib/harvester.ts`: Harvester and `NodeImage` data to form choices (no dependencies)
- `lib/status.ts`: object status to progress phases, problems, pool and machine rows (no dependencies)
- `lib/release.ts`: the release, upgrade phases, pre-flight, readiness, running versions (no dependencies)
- `lib/catalog.ts`: the release catalog and the fallback when there is none (no dependencies)
- `lib/manage.ts`: automatic replacement, node labels, certificate rotation, snapshots (no dependencies)

## Build, lint, test

```sh
yarn install --frozen-lockfile
yarn build-pkg elemental3
yarn lint:elemental3
yarn test:elemental3
```
