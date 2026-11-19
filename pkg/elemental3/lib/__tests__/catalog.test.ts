import {
  CATALOG_PATH, catalogLabel, catalogOptions, componentText, currentLineage, knownReleases, notOfferedGroups, pickedRelease, staleSources
} from '../catalog';
import { ReleaseOption, offeredReleases } from '../release';

const PUBLISHED = 'registry.example/beta/uc/rke2/rke2-manifest';
const CARRIED = '192.0.2.5:5000/e3p/rke2-manifest';

/** AvailableRelease objects as the catalog controller writes them (shape of `kubectl get availablereleases -o json`). */
const entry = (source: string, registry: string, version: string, lineage: string, kubernetes: string, os: string, stale = false) => ({
  apiVersion: 'lifecycle.suse.com/v1alpha1',
  kind:       'AvailableRelease',
  metadata:   { name: `${ source }-${ version }`, labels: { 'lifecycle.suse.com/source': source, 'lifecycle.suse.com/lineage': lineage } },
  spec:       {
    source,
    registry,
    version,
    lineage,
    digest:          'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    manifest:        `${ registry }@sha256:0000000000000000000000000000000000000000000000000000000000000000`,
    operatingSystem: { image: `registry.example/os:${ os }`, version: os },
    kubernetes:      { version: kubernetes, image: 'registry.example/rke2-tar:x' },
  },
  status: { stale, discoveredAt: '2026-11-19T18:00:00Z' },
});

const catalogList = {
  kind:  'AvailableReleaseList',
  items: [
    entry('published', PUBLISHED, '1.37.1-17.1', 'suse-core', 'v1.37.1+rke2r1', '16.1-70.1'),
    entry('published', PUBLISHED, '1.37.2-20.3', 'suse-core', 'v1.37.2+rke2r1', '16.1-76.43'),
    entry('carried', CARRIED, '1.37.2-20.3-e3p.1', 'suse-core', 'v1.37.2+rke2r1', '16.1-76.43-e3p.1', true),
    entry('solutions', 'registry.example/solutions/rke2-manifest', '1.38.0-1.1', 'harvester', 'v1.38.0+rke2r1', '16.2-1.1'),
    entry('published', PUBLISHED, '1.36.9-1.1', 'suse-core', 'v1.36.9+rke2r1', '16.0-9.1'),
  ],
};

const fallback: ReleaseOption[] = [{
  registry: CARRIED, version: '1.37.2-20.3-e3p.1', source: 'image'
}];

const httpError = (status: number) => Object.assign(new Error(`HTTP ${ status }`), { _status: status });

describe('catalogLabel and pickedRelease', () => {
  const words = { stale: 'last known', source: (name: string) => `source ${ name }` };
  const options = catalogOptions(catalogList.items);

  it('same repository as the current release: version, Kubernetes, OS', () => {
    expect(catalogLabel(options[1], PUBLISHED, words)).toBe('1.37.2-20.3 · Kubernetes v1.37.2+rke2r1, OS 16.1-76.43');
  });

  it('another repository: the catalog source is named, not the repository; the stale mark comes right after the version', () => {
    const label = catalogLabel(options[2], PUBLISHED, words);

    expect(label).toBe('1.37.2-20.3-e3p.1 · last known · Kubernetes v1.37.2+rke2r1, OS 16.1-76.43-e3p.1 · source carried');
    expect(label).not.toContain(CARRIED);
    // 0.5.0 made 'version from <repository> (release catalog) · Kubernetes ..., OS ... · last known, source not reachable':
    // 1049 px for this kind of entry on the lab catalog, wider than the page, with the stale mark cut off
    expect(label.indexOf('last known')).toBeLessThan(40);
    expect(label.length).toBeLessThan(100);
  });

  it('an entry without a source name falls back to the repository, and nothing is added when no current repository is known', () => {
    expect(catalogLabel({
      ...options[2], catalogSource: undefined, stale: false
    }, PUBLISHED, words)).toBe(`1.37.2-20.3-e3p.1 · Kubernetes v1.37.2+rke2r1, OS 16.1-76.43-e3p.1 · ${ CARRIED }`);
    expect(catalogLabel(options[2], '', words)).toBe('1.37.2-20.3-e3p.1 · last known · Kubernetes v1.37.2+rke2r1, OS 16.1-76.43-e3p.1');
  });

  it('finds the entry a selected or typed target names: version and repository, an oci:// prefix does not matter', () => {
    expect(pickedRelease(options, { registry: CARRIED, version: '1.37.2-20.3-e3p.1' })?.stale).toBe(true);
    expect(pickedRelease(options, { registry: `oci://${ CARRIED }/`, version: '1.37.2-20.3-e3p.1' })?.catalogSource).toBe('carried');
    expect(pickedRelease(options, { registry: PUBLISHED, version: '1.37.2-20.3-e3p.1' })).toBeUndefined();
    expect(pickedRelease(options, { registry: CARRIED, version: '9.9.9-1.1' })).toBeUndefined();
    expect(pickedRelease(options, null)).toBeUndefined();
  });
});

describe('catalogOptions', () => {
  it('reads version, repository, lineage, Kubernetes, OS and the stale mark', () => {
    const out = catalogOptions(catalogList.items);

    expect(out).toHaveLength(5);
    expect(out[2]).toStrictEqual({
      registry: CARRIED, version: '1.37.2-20.3-e3p.1', source: 'catalog', lineage: 'suse-core', kubernetes: 'v1.37.2+rke2r1', os: '16.1-76.43-e3p.1', stale: true, catalogSource: 'carried'
    });
    expect(out[0].stale).toBe(false);
  });

  it('leaves out objects without a repository or version and tolerates an oci:// prefix', () => {
    expect(catalogOptions([{}, { spec: { registry: 'r/m' } }, { spec: { version: '1.0.0' } }, null as any])).toStrictEqual([]);
    expect(catalogOptions([{ spec: { registry: 'oci://r/m/', version: '1.0.0' } }])[0].registry).toBe('r/m');
  });

  it('names the sources that are stale, each once', () => {
    expect(staleSources(catalogList.items)).toStrictEqual(['carried']);
    expect(staleSources([])).toStrictEqual([]);
  });

  it('says what a release contains', () => {
    expect(componentText(catalogOptions(catalogList.items)[1])).toBe('Kubernetes v1.37.2+rke2r1, OS 16.1-76.43');
    expect(componentText(fallback[0])).toBe('');
  });
});

describe('knownReleases', () => {
  it('reads the catalog collection of the management cluster', () => {
    expect(CATALOG_PATH).toBe('/apis/lifecycle.suse.com/v1alpha1/availablereleases');
  });

  it('lists the catalog and does not ask the fallback sources when the catalog has releases', async() => {
    let asked = 0;
    const readFallback = async() => {
      asked++;

      return fallback;
    };
    const out = await knownReleases(async() => catalogList, readFallback);

    expect(out.from).toBe('catalog');
    expect(out.catalog).toBe('installed');
    expect(out.known.map((k) => k.source)).toStrictEqual(['catalog', 'catalog', 'catalog', 'catalog', 'catalog']);
    expect(out.staleSources).toStrictEqual(['carried']);
    expect(asked).toBe(0);
  });

  it('falls back to the Harvester image annotation when the definition is not installed (HTTP 404): today\'s behaviour', async() => {
    let asked = 0;
    const readFallback = async() => {
      asked++;

      return fallback;
    };
    const out = await knownReleases(async() => {
      throw httpError(404);
    }, readFallback);

    expect(out).toStrictEqual({
      known: fallback, from: 'fallback', catalog: 'absent', staleSources: []
    });
    expect(asked).toBe(1);

    // The picker then offers exactly what 0.4.0 offered: the release of the annotated node image.
    const offered = offeredReleases(out.known, { registry: PUBLISHED, version: '1.37.1-17.1' }, currentLineage({ registry: PUBLISHED, version: '1.37.1-17.1' }, out.known));

    expect(offered).toStrictEqual([{
      registry: CARRIED, version: '1.37.2-20.3-e3p.1', source: 'image', blocked: ''
    }]);
  });

  it('falls back when the account may not read the catalog, when it is empty, and on any other error', async() => {
    expect((await knownReleases(async() => {
      throw httpError(403);
    }, async() => fallback))).toMatchObject({
      from: 'fallback', catalog: 'denied', known: fallback
    });
    expect((await knownReleases(async() => ({ items: [] }), async() => fallback))).toMatchObject({
      from: 'fallback', catalog: 'empty', known: fallback
    });
    expect((await knownReleases(async() => {
      throw new Error('network');
    }, async() => fallback))).toMatchObject({
      from: 'fallback', catalog: 'error', known: fallback
    });
    expect((await knownReleases(async() => null, async() => fallback)).catalog).toBe('empty');
  });

  it('never fails the page: a failing fallback gives an empty list', async() => {
    const out = await knownReleases(async() => {
      throw httpError(404);
    }, async() => {
      throw new Error('harvester down');
    });

    expect(out).toStrictEqual({
      known: [], from: 'fallback', catalog: 'absent', staleSources: []
    });
  });
});

describe('the picker with the catalog', () => {
  const known = catalogOptions(catalogList.items);
  const verdicts = (current: { registry: string; version: string }) => Object.fromEntries(
    offeredReleases(known, current, currentLineage(current, known)).map((o) => [o.version, o.blocked || 'offered'])
  );

  it('finds the lineage of the current release in the catalog, preferring its own repository', () => {
    expect(currentLineage({ registry: PUBLISHED, version: '1.37.1-17.1' }, known)).toBe('suse-core');
    expect(currentLineage({ registry: `oci://${ PUBLISHED }`, version: '1.37.1-17.1' }, known)).toBe('suse-core');
    expect(currentLineage({ registry: PUBLISHED, version: '1.0.0' }, known)).toBe('');
    expect(currentLineage(null, known)).toBe('');
    expect(currentLineage({ registry: 'mirror.example/x/rke2-manifest', version: '1.37.1-17.1' }, [
      ...known, {
        registry: 'mirror.example/x/rke2-manifest', version: '1.37.1-17.1', source: 'catalog', lineage: 'mirror-line'
      }
    ])).toBe('mirror-line');
  });

  it('offers higher versions of the same lineage, also from another repository; hides the rest with a reason', () => {
    expect(verdicts({ registry: PUBLISHED, version: '1.37.1-17.1' })).toStrictEqual({
      '1.38.0-1.1':        'otherLineage',
      '1.37.2-20.3-e3p.1': 'offered',
      '1.37.2-20.3':       'offered',
      '1.37.1-17.1':       'notNewer',
      '1.36.9-1.1':        'notNewer',
    });
  });

  it('does not offer a downgrade from the carried release to the release it was built from', () => {
    expect(verdicts({ registry: CARRIED, version: '1.37.2-20.3-e3p.1' })).toStrictEqual({
      '1.38.0-1.1':        'otherLineage',
      '1.37.2-20.3-e3p.1': 'notNewer',
      '1.37.2-20.3':       'notNewer',
      '1.37.1-17.1':       'notNewer',
      '1.36.9-1.1':        'notNewer',
    });
  });

  it('uses the manifest\'s lineage, not the repository name: a solution in a repository of the same name is not offered', () => {
    // registry.example/solutions/rke2-manifest has the repository name of the core line and the lineage "harvester"
    expect(verdicts({ registry: PUBLISHED, version: '1.37.2-20.3' })['1.38.0-1.1']).toBe('otherLineage');
  });

  it('falls back to the repository name when the catalog does not hold the current release', () => {
    const out = verdicts({ registry: 'registry.example/elsewhere/rke2-manifest', version: '1.37.0-1.1' });

    // lineage unknown: every repository named rke2-manifest counts, as before the catalog
    expect(out['1.37.2-20.3']).toBe('offered');
    expect(out['1.38.0-1.1']).toBe('offered');
    expect(verdicts({ registry: 'registry.example/elsewhere/other-manifest', version: '1.37.0-1.1' })['1.37.2-20.3']).toBe('otherLineage');
  });
});

describe('notOfferedGroups', () => {
  const known = catalogOptions(catalogList.items);
  const current = { registry: PUBLISHED, version: '1.37.2-20.3' };

  it('gives one line per reason with the first versions and a count, and leaves the current release out', () => {
    const offered = offeredReleases(known, current, currentLineage(current, known));

    expect(notOfferedGroups(offered, current.version, 1)).toStrictEqual([
      {
        blocked: 'otherLineage', count: 1, versions: ['1.38.0-1.1'], more: 0
      },
      {
        blocked: 'notNewer', count: 2, versions: ['1.37.1-17.1'], more: 1
      },
    ]);
  });

  it('is empty when everything known is offered or nothing is known', () => {
    expect(notOfferedGroups(offeredReleases(known, null))).toStrictEqual([]);
    expect(notOfferedGroups([])).toStrictEqual([]);
  });
});
