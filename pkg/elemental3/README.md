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

## Layout

- `provisioner.ts`: the card (`IClusterProvisioner` with its own `component`)
- `components/CreateCluster.vue`: the form
- `lib/objects.ts`: form values to objects, and validation (no dependencies)
- `lib/harvester.ts`: Harvester and `NodeImage` data to form choices (no dependencies)

## Build, lint, test

```sh
yarn install --frozen-lockfile
yarn build-pkg elemental3
yarn lint:elemental3
yarn test:elemental3
```
