import {
  IMAGE_KUBERNETES_ANNOTATION, IMAGE_RELEASE_ANNOTATION, endpointAccessReviews, errorText, imageOptions, keyPairOptions, loadBalancerRight, namespaceOptions, networkOptions, nodeImageOptions, releaseName
} from '../harvester';

const ready = { conditions: [{ type: 'Ready', status: 'True' }] };

describe('namespaceOptions', () => {
  it('offers namespaces the user may write to, without system namespaces', () => {
    const list = [
      { metadata: { name: 'tenant' }, links: { update: 'u' } },
      { metadata: { name: 'read-only' }, links: {} },
      { metadata: { name: 'kube-system' }, links: { update: 'u' } },
      { metadata: { name: 'harvester-system' }, links: { update: 'u' } },
      { metadata: { name: 'alpha' }, links: { update: 'u' } },
    ];

    expect(namespaceOptions(list).map((o) => o.value)).toStrictEqual(['alpha', 'tenant']);
    expect(namespaceOptions(undefined as any)).toStrictEqual([]);
  });
});

describe('networkOptions and keyPairOptions', () => {
  it('use namespace/name', () => {
    expect(networkOptions([{ id: 'tenant/vlan' }, { metadata: { namespace: 'a', name: 'b' } }]).map((o) => o.value)).toStrictEqual(['a/b', 'tenant/vlan']);
  });

  it('keeps key pairs of the VM namespace only', () => {
    const keys = [{ id: 'tenant/k1', metadata: { namespace: 'tenant', name: 'k1' } }, { id: 'other/k2', metadata: { namespace: 'other', name: 'k2' } }];

    expect(keyPairOptions(keys, 'tenant').map((o) => o.value)).toStrictEqual(['tenant/k1']);
    expect(keyPairOptions(keys, '').map((o) => o.value)).toStrictEqual(['other/k2', 'tenant/k1']);
  });
});

describe('imageOptions', () => {
  it('lists imported disk images by display name and leaves out ISOs and unfinished imports', () => {
    const imported = { conditions: [{ type: 'Imported', status: 'True' }] };
    const images = [
      {
        id: 'tenant/img-1', metadata: { namespace: 'tenant', name: 'img-1' }, spec: { displayName: 'node.qcow2' }, status: imported
      },
      {
        id: 'tenant/img-2', metadata: { namespace: 'tenant', name: 'img-2' }, spec: { displayName: 'installer.ISO' }, status: imported
      },
      {
        id: 'tenant/img-3', metadata: { namespace: 'tenant', name: 'img-3' }, spec: { displayName: 'pending.qcow2' }, status: { conditions: [{ type: 'Imported', status: 'False' }] }
      },
    ];

    expect(imageOptions(images)).toStrictEqual([{
      name:    'tenant/node.qcow2',
      release: '',
      label:   'tenant/node.qcow2',
      value:   {
        image: 'tenant/img-1', kubernetesVersion: '', releaseManifest: '', fromOperator: false, verified: false
      },
    }]);
  });

  const imported = { conditions: [{ type: 'Imported', status: 'True' }] };
  const image = (name: string, annotations: any) => ({
    id:       `tenant/${ name }`,
    metadata: {
      namespace: 'tenant', name, annotations
    },
    spec:   { displayName: `${ name }.qcow2` },
    status: imported
  });

  it('takes release and Kubernetes version from the annotations of the image, so nothing is typed', () => {
    const out = imageOptions([image('e3-1371', {
      [IMAGE_RELEASE_ANNOTATION]:    'registry.example/uc/rke2-manifest:1.37.1-17.1',
      [IMAGE_KUBERNETES_ANNOTATION]: 'v1.37.1+rke2r1',
    })]);

    expect(out[0].release).toBe('rke2-manifest:1.37.1-17.1');
    expect(out[0].value).toStrictEqual({
      image: 'tenant/e3-1371', kubernetesVersion: 'v1.37.1+rke2r1', releaseManifest: 'registry.example/uc/rke2-manifest:1.37.1-17.1', fromOperator: false, verified: true
    });
  });

  it.each([
    ['no annotations', undefined],
    ['the release only', { [IMAGE_RELEASE_ANNOTATION]: 'registry.example/uc/rke2-manifest:1.37.1-17.1' }],
    ['the version only', { [IMAGE_KUBERNETES_ANNOTATION]: 'v1.37.1+rke2r1' }],
    ['a version that is not an RKE2 version', { [IMAGE_RELEASE_ANNOTATION]: 'registry.example/uc/rke2-manifest:1.37.1-17.1', [IMAGE_KUBERNETES_ANNOTATION]: '1.37' }],
  ])('lists an image with %s as not verified and takes nothing from it', (_what, annotations) => {
    const out = imageOptions([image('some', annotations)]);

    expect(out[0].value.verified).toBe(false);
    expect(out[0].value.kubernetesVersion).toBe('');
    expect(out[0].value.releaseManifest).toBe('');
  });

  it('lists described images before images nobody vouches for', () => {
    const out = imageOptions([
      image('a-unknown', {}),
      image('z-described', { [IMAGE_RELEASE_ANNOTATION]: 'r.example/rke2-manifest:1.37.2-20.3', [IMAGE_KUBERNETES_ANNOTATION]: 'v1.37.2+rke2r1' }),
    ]);

    expect(out.map((o) => o.value.image)).toStrictEqual(['tenant/z-described', 'tenant/a-unknown']);
  });
});

describe('control plane load balancer right', () => {
  it('asks Harvester what the Harvester provider needs: create and delete load balancers in the VM namespace, nothing outside it', () => {
    const reviews = endpointAccessReviews('tenant');

    expect(reviews.map((r) => r.spec.resourceAttributes)).toStrictEqual([
      {
        group: 'loadbalancer.harvesterhci.io', resource: 'loadbalancers', verb: 'create', namespace: 'tenant'
      },
      {
        group: 'loadbalancer.harvesterhci.io', resource: 'loadbalancers', verb: 'delete', namespace: 'tenant'
      },
    ]);
  });

  it('is allowed only when the user may do both, and denied as soon as Harvester says no to one', () => {
    expect(loadBalancerRight([true, true])).toBe('allowed');
    expect(loadBalancerRight([true, false])).toBe('denied');
    expect(loadBalancerRight([false, null])).toBe('denied');
  });

  it('is unknown, not denied, when Harvester did not answer', () => {
    expect(loadBalancerRight([null, true])).toBe('unknown');
    expect(loadBalancerRight([])).toBe('unknown');
  });
});

describe('nodeImageOptions', () => {
  const nodeImage = (over: any = {}) => ({
    spec: {
      release: { manifest: 'registry.example/uc/rke2-manifest:1.37.2-20.3' }, target: { type: 'harvester', harvester: { namespace: 'tenant' } }, ...over.spec
    },
    status: {
      ...ready,
      image: {
        name: 'img-abc', namespace: 'tenant', kubernetesVersion: 'v1.37.2+rke2r1'
      },
      ...over.status
    },
  });

  it('turns a ready NodeImage into a release with image and version', () => {
    expect(nodeImageOptions([nodeImage()], 'tenant')).toStrictEqual([{
      release: 'rke2-manifest:1.37.2-20.3',
      label:   'rke2-manifest:1.37.2-20.3',
      value:   {
        image: 'tenant/img-abc', kubernetesVersion: 'v1.37.2+rke2r1', releaseManifest: 'registry.example/uc/rke2-manifest:1.37.2-20.3', fromOperator: true, verified: true
      },
    }]);
  });

  it('skips images that are not ready, for another target, another namespace or another architecture', () => {
    const list = [
      nodeImage({ status: { conditions: [{ type: 'Ready', status: 'False' }] } }),
      nodeImage({ spec: { target: { type: 'aws' } } }),
      nodeImage({ spec: { arch: 'aarch64' } }),
      nodeImage({
        status: {
          image: {
            name: 'x', namespace: 'other', kubernetesVersion: 'v1.37.2+rke2r1'
          }
        }
      }),
      nodeImage({ status: { image: { name: 'no-version', namespace: 'tenant' } } }),
    ];

    expect(nodeImageOptions(list, 'tenant')).toStrictEqual([]);
  });

  it('lists an image once when two requests resolved to it', () => {
    expect(nodeImageOptions([nodeImage(), nodeImage()], 'tenant')).toHaveLength(1);
  });
});

describe('releaseName and errorText', () => {
  it('shortens a manifest reference', () => {
    expect(releaseName('registry.example/a/b/rke2-manifest:1.0')).toBe('rke2-manifest:1.0');
  });

  it('finds the readable part of an error', () => {
    expect(errorText('plain')).toBe('plain');
    expect(errorText({ message: 'forbidden' })).toBe('forbidden');
    expect(errorText({ _status: 403 })).toBe('HTTP 403');
    expect(errorText(undefined)).toBe('unknown error');
  });
});
