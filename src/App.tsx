import { useEffect, useState } from 'react';
import type { Ability, Hero, Item } from './types';
import { img, loadCore, type Manifest } from './data/load';
import { BrawlView } from './components/BrawlView';
import { TierList } from './components/TierList';
import { TitleBar } from './components/TitleBar';
import { usePersisted, isNumber, isString } from './hooks/usePersisted';

const INFERNUS = 1;

const TABS = [
  { key: 'advisor', label: 'Draft advisor' },
  { key: 'tiers', label: 'Street Brawl Tier List' },
] as const;
type Tab = (typeof TABS)[number]['key'];
const isTab = (v: unknown): v is Tab => isString(v) && TABS.some((t) => t.key === v);

export default function App() {
  const [items, setItems] = useState<Item[]>([]);
  const [heroes, setHeroes] = useState<Hero[]>([]);
  const [abilities, setAbilities] = useState<Ability[]>([]);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [heroId, setHeroId] = usePersisted('heroId', isNumber, INFERNUS);
  const [tab, setTab] = usePersisted<Tab>('tab', isTab, 'advisor');
  const [error, setError] = useState<string | null>(null);
  const [debug, setDebug] = useState(false); // hidden Debug panel; never persisted
  const [changeHero, setChangeHero] = useState(false);
  const [heroSource, setHeroSource] = useState<'detected' | 'manual'>('manual');
  const handleHero = (id: number, source: 'detected' | 'manual' = 'manual') => {
    setHeroId(id);
    setHeroSource(source);
  };

  useEffect(() => {
    loadCore()
      .then(([i, h, a, m]) => {
        setItems(i);
        setHeroes(h);
        setAbilities(a);
        setManifest(m);
      })
      .catch((e) => setError(String(e)));
  }, []);

  // Ctrl+Shift+D (and the tray's "Debug panel" entry) toggles the Debug panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        setDebug((d) => !d);
      }
    };
    window.addEventListener('keydown', onKey);
    const off = window.brawlAPI?.onDebugToggle(() => setDebug((d) => !d));
    return () => {
      window.removeEventListener('keydown', onKey);
      off?.();
    };
  }, []);

  const hero = heroes.find((h) => h.id === heroId);

  if (error)
    return (
      <>
        <TitleBar />
        <div className="error">{error}</div>
      </>
    );
  if (!hero)
    return (
      <>
        <TitleBar />
        <div className="loading">Loading snapshots…</div>
      </>
    );

  const fetchedAt = manifest?.brawl?.fetched_at ?? manifest?.fetched_at;
  const fetchedDate = fetchedAt?.slice(0, 10);
  const ageDays = fetchedAt ? Math.floor((Date.now() - Date.parse(fetchedAt)) / 86400000) : null;
  const stale = ageDays !== null && ageDays > 14;

  return (
    <>
      <TitleBar />
      <header className="app-header">
        {tab === 'advisor' && <img className="hero-portrait" src={img(hero.images.small)} alt="" />}
        <div>
          <h1>
            {tab === 'advisor' ? hero.name : 'Street Brawl Tier List'}
            {tab === 'advisor' && heroSource === 'detected' && (
              <span className="hero-auto-badge" title="Auto-detected from the scoreboard">
                auto
              </span>
            )}
          </h1>
          {tab === 'advisor' ? (
            heroSource === 'detected' && !changeHero ? (
              <button className="link-btn" onClick={() => setChangeHero(true)}>
                change
              </button>
            ) : (
              <select
                className="hero-select"
                value={heroId}
                onChange={(e) => handleHero(Number(e.target.value), 'manual')}
                aria-label="Select hero"
              >
                {heroes.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name}
                  </option>
                ))}
              </select>
            )
          ) : (
            <div className="sub">
              Heroes and items graded by win rate and usage, data from the 30 days to {fetchedDate}
              {ageDays !== null && (
                <span className={stale ? 'stale' : ''}>
                  {' '}
                  ({ageDays} day{ageDays === 1 ? '' : 's'} old)
                </span>
              )}
            </div>
          )}
        </div>
      </header>
      <nav className="tabs" role="tablist" aria-label="View">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            className={tab === t.key ? 'active' : ''}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </nav>
      {/* BrawlView stays mounted on both tabs: it owns the capture loop and the hidden <video>. */}
      <div hidden={tab !== 'advisor'}>
        <BrawlView hero={hero} heroes={heroes} items={items} abilities={abilities} onHero={handleHero} debug={debug} />
      </div>
      {tab === 'tiers' && <TierList heroes={heroes} items={items} />}
      <footer>
        Data: deadlock-api.com (aggregate analytics, assets). See the{' '}
        <a href="https://github.com/Gidntsquia/deadlock-street-brawl-helper/wiki/Street-Brawl-Advisor">
          Street Brawl Advisor
        </a>{' '}
        wiki page for the scoring function.
      </footer>
    </>
  );
}
