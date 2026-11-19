/**
 * The release catalog of the management cluster: AvailableRelease objects (lifecycle.suse.com/v1alpha1,
 * cluster-scoped) written by the catalog controller of the Lifecycle Manager, one per release found in a
 * ReleaseSource (an OCI repository of release manifests). The picker reads them first; where the catalog
 * is not installed, not readable or empty it falls back to what the page knew before (node images of the
 * build operator, annotated Harvester images, other clusters).
 */
import { OfferedRelease, ReleaseOption, ReleaseRef } from './release';

/** Collection path relative to the Kubernetes API root of the management cluster. */
export const CATALOG_PATH = '/apis/lifecycle.suse.com/v1alpha1/availablereleases';

/**
 * installed: the catalog answered with at least one release. empty: it answered with none.
 * absent: the API does not exist (HTTP 404, the definition is not installed). denied: HTTP 403.
 * error: anything else.
 */
export type CatalogState = 'installed' | 'empty' | 'absent' | 'denied' | 'error';

export interface KnownReleases {
  known: ReleaseOption[];
  /** Which list the picker shows */
  from: 'catalog' | 'fallback';
  catalog: CatalogState;
  /** Catalog sources whose entries are the last known ones */
  staleSources: string[];
}

function clean(registry: string): string {
  return `${ registry || '' }`.trim().replace(/^oci:\/\//, '').replace(/\/+$/, '');
}

/** AvailableRelease objects as picker entries. Objects without a repository or a version are left out. */
export function catalogOptions(items: any[]): ReleaseOption[] {
  const out: ReleaseOption[] = [];

  (items || []).forEach((item) => {
    const spec = item?.spec || {};
    const registry = clean(spec.registry);

    if (!registry || !spec.version) {
      return;
    }
    out.push({
      registry,
      version:    `${ spec.version }`,
      source:     'catalog',
      lineage:    spec.lineage || '',
      kubernetes: spec.kubernetes?.version || '',
      os:         spec.operatingSystem?.version || '',
      stale:      item?.status?.stale === true,
      ...(spec.source ? { catalogSource: `${ spec.source }` } : {}),
    });
  });

  return out;
}

/** Names of the sources that have at least one stale entry. */
export function staleSources(items: any[]): string[] {
  const names = (items || []).filter((i) => i?.status?.stale === true).map((i) => `${ i?.spec?.source || '' }`).filter((n) => !!n);

  return [...new Set(names)].sort();
}

/**
 * Lineage of the cluster's current release, looked up in the catalog: the entry with the same version,
 * preferring the one from the same repository. '' when the catalog does not hold the current release.
 */
export function currentLineage(current: ReleaseRef | null, known: ReleaseOption[]): string {
  if (!current?.version) {
    return '';
  }
  const same = (known || []).filter((k) => k.version === current.version && !!k.lineage);
  const here = same.find((k) => clean(k.registry) === clean(current.registry));

  return (here || same[0])?.lineage || '';
}

function status(e: any): number {
  return e?._status || e?.status || e?.response?.status || 0;
}

/**
 * What the picker lists. `readCatalog` reads the AvailableRelease collection and rejects with the HTTP
 * status when it cannot; `readFallback` collects what the page knew before the catalog existed. The
 * fallback is read only when the catalog has nothing to offer, and a failing catalog never fails the page.
 */
export async function knownReleases(readCatalog: () => Promise<any>, readFallback: () => Promise<ReleaseOption[]>): Promise<KnownReleases> {
  let catalog: CatalogState;
  let items: any[] = [];

  try {
    const list = await readCatalog();

    items = list?.items || list?.data || [];
    catalog = catalogOptions(items).length ? 'installed' : 'empty';
  } catch (e) {
    const code = status(e);

    catalog = code === 404 ? 'absent' : (code === 403 || code === 401 ? 'denied' : 'error');
  }

  if (catalog === 'installed') {
    return {
      known: catalogOptions(items), from: 'catalog', catalog, staleSources: staleSources(items)
    };
  }

  let known: ReleaseOption[] = [];

  try {
    known = (await readFallback()) || [];
  } catch (e) {}

  return {
    known, from: 'fallback', catalog, staleSources: []
  };
}

/** "Kubernetes v1.37.2+rke2r1, OS 16.1-76.43" out of what the catalog states; '' for entries from elsewhere. */
export function componentText(o: ReleaseOption): string {
  return [o.kubernetes ? `Kubernetes ${ o.kubernetes }` : '', o.os ? `OS ${ o.os }` : ''].filter((x) => !!x).join(', ');
}

/**
 * The text of a picker entry out of the catalog, short enough for a select: the version first, then the
 * stale mark (it must not be the part a narrow list cuts off), Kubernetes and OS, and last the catalog
 * source when the release comes from another repository than the cluster's current one. The repository
 * itself is not in the entry (0.5.0 put it there and the list ran off the page); the page shows it for
 * the selected release. `words` are the translated texts.
 */
export function catalogLabel(o: ReleaseOption, currentRegistry: string, words: { stale: string; source: (name: string) => string }): string {
  const elsewhere = !!currentRegistry && clean(o.registry) !== clean(currentRegistry);

  return [
    o.version,
    o.stale ? words.stale : '',
    componentText(o),
    elsewhere ? (o.catalogSource ? words.source(o.catalogSource) : clean(o.registry)) : '',
  ].filter((x) => !!x).join(' · ');
}

/**
 * The known release the picker's target names, whether it was selected or typed: same version and same
 * repository. undefined for a target the page knows nothing about.
 */
export function pickedRelease<T extends ReleaseOption>(known: T[], target: ReleaseRef | null): T | undefined {
  if (!target?.version) {
    return undefined;
  }

  return (known || []).find((k) => k.version === target.version && clean(k.registry) === clean(target.registry));
}

export interface NotOfferedGroup {
  blocked: OfferedRelease['blocked'];
  /** Number of distinct versions not offered for this reason */
  count: number;
  /** The first versions (highest first), at most `show` */
  versions: string[];
  /** count minus the versions named */
  more: number;
}

/**
 * Known releases that are not valid targets, one group per reason, so that a catalog with fifty old
 * releases makes one line and not fifty. The current release itself is not counted.
 */
export function notOfferedGroups(offered: OfferedRelease[], currentVersion = '', show = 3): NotOfferedGroup[] {
  const order: OfferedRelease['blocked'][] = ['otherLineage', 'notComparable', 'notNewer'];

  return order.map((blocked) => {
    const versions = [...new Set((offered || []).filter((o) => o.blocked === blocked && o.version !== currentVersion).map((o) => o.version))];

    return {
      blocked, count: versions.length, versions: versions.slice(0, show), more: Math.max(0, versions.length - show)
    };
  }).filter((g) => g.count > 0);
}
