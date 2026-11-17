import {
  errorText, imageOptions, keyPairOptions, namespaceOptions, networkOptions, nodeImageOptions, releaseName
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
      name:  'tenant/node.qcow2',
      label: 'tenant/node.qcow2',
      value: {
        image: 'tenant/img-1', kubernetesVersion: '', releaseManifest: '', fromOperator: false
      },
    }]);
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
        image: 'tenant/img-abc', kubernetesVersion: 'v1.37.2+rke2r1', releaseManifest: 'registry.example/uc/rke2-manifest:1.37.2-20.3', fromOperator: true
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
