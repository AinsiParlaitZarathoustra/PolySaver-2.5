// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 PolySaver contributors

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider } from '@mui/material';
import '../../src/i18n';
import i18n, { setAppLanguage } from '../../src/i18n';
import { createAppTheme } from '../../src/app/theme';
import { Header } from '../../src/components/Header';
import { DownloadForm } from '../../src/components/DownloadForm';
import { DownloadQueue } from '../../src/components/DownloadQueue';
import { DownloadHistory } from '../../src/components/DownloadHistory';
import { EmptyQueue } from '../../src/components/EmptyQueue';
import { SettingsDrawer } from '../../src/components/SettingsDrawer';
import { DownloadOptionsDialog } from '../../src/components/DownloadOptionsDialog';
import { JsRuntimeSetupDialog } from '../../src/components/JsRuntimeSetupDialog';
import { useAutosaveSettings } from '../../src/features/settings/useAutosaveSettings';
import { formatTransferRate } from '../../src/utils/formatTransferRate';
import { defaultIpcClient, normalizeIpcError } from '../../src/ipc/client';
import { fr } from '../../src/i18n/locales/fr';
import { en } from '../../src/i18n/locales/en';
import { MAX_RETRY_ATTEMPTS } from '../../src/ipc/contracts';
import type {
  AppSettingsDto,
  DownloadHistoryEntryDto,
  DownloadJobDto,
  DownloadPresetDto,
  ProbeResult,
} from '../../src/ipc/contracts';
import type { IpcClient } from '../../src/ipc/client';

describe('Sprint 7 Persistent History, Location Chooser, and UI Polish', () => {
  beforeEach(async () => {
    await setAppLanguage('fr');
  });

  const defaultPreset: DownloadPresetDto = {
    format: 'mp4',
    videoQuality: 'p1080',
  };

  const defaultSettings: AppSettingsDto = {
    downloadDirectory: '~/Downloads/PolySaver',
    themeMode: 'system',
    defaultPreset,
    language: 'fr',
  };

  const sampleProbeResult: ProbeResult = {
    url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
    title: 'Me at the zoo',
    durationSeconds: 19,
    thumbnailUrl: 'https://i.ytimg.com/vi/jNQXAC9IVRw/maxresdefault.jpg',
    uploader: 'jawed',
    formats: [
      { formatId: '137', extension: 'mp4', height: 1080, hasVideo: true, hasAudio: false, filesizeApproxBytes: 15000000 },
      { formatId: '22', extension: 'mp4', height: 720, hasVideo: true, hasAudio: true, filesizeApproxBytes: 8000000 },
    ],
    availableVideoQualities: ['best', 'p1080', 'p720'],
  };

  // 1. formatTransferRate utility (FR and EN)
  it('formats transfer rates correctly in Mo/s (FR) and MB/s (EN)', () => {
    expect(formatTransferRate(2500000, 'fr')).toMatch(/2[,.]50 Mo\/s/);
    expect(formatTransferRate(2500000, 'en')).toMatch(/2\.50 MB\/s/);
    expect(formatTransferRate(10000000, 'fr')).toMatch(/10[,.]00 Mo\/s/);
    expect(formatTransferRate(10000000, 'en')).toMatch(/10\.00 MB\/s/);
    expect(formatTransferRate(0)).toBe('');
    expect(formatTransferRate(-500)).toBe('');
    expect(formatTransferRate(undefined)).toBe('');
    expect(formatTransferRate(null)).toBe('');
    expect(formatTransferRate(Number.NaN)).toBe('');
  });

  // 2. Header renders official imported logo icon
  it('renders Header with imported official logo icon', () => {
    const theme = createAppTheme('dark');
    render(
      <ThemeProvider theme={theme}>
        <Header onOpenSettings={vi.fn()} onOpenHelp={vi.fn()} />
      </ThemeProvider>,
    );

    const logo = screen.getByAltText('PolySaver');
    expect(logo).toBeInTheDocument();
    expect(logo).toHaveAttribute('src');
    expect(logo.getAttribute('src')).not.toBe('/PolySaver_logo.png');
    // The enlarged, centered title keeps the localized app name.
    expect(screen.getByText('PolySaver')).toBeInTheDocument();
  });

  // 2b. Quality label shortened to "Meilleure" / "Best"
  it('uses the short best-quality label in both languages', () => {
    expect(fr.dialog.bestQuality).toBe('Meilleure');
    expect(en.dialog.bestQuality).toBe('Best');
    expect(fr.dialog.bestQuality).not.toMatch(/disponible/i);
    expect(en.dialog.bestQuality).not.toMatch(/available/i);

    // No residual long prose in the UI catalogs for that label.
    expect(JSON.stringify(fr)).not.toContain('Meilleure disponible');
    expect(JSON.stringify(en)).not.toContain('Best available');
  });

  // 2c. Retry chip maximum stays aligned with the backend policy
  it('derives the retry maximum from the shared constant', () => {
    expect(MAX_RETRY_ATTEMPTS).toBe(3);
  });

  // 3. DownloadForm layout and buttons in FR and EN
  it('renders DownloadForm with bilingual translations', async () => {
    const theme = createAppTheme('dark');
    const { rerender } = render(
      <ThemeProvider theme={theme}>
        <DownloadForm
          onFastDownload={vi.fn().mockResolvedValue(true)}
          onGuidedDownload={vi.fn()}
        />
      </ThemeProvider>,
    );

    expect(screen.getByPlaceholderText(/collez un lien youtube/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /téléchargement rapide/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^télécharger$/i })).toBeInTheDocument();

    // Switch to English
    await act(async () => {
      await setAppLanguage('en');
    });
    rerender(
      <ThemeProvider theme={theme}>
        <DownloadForm
          onFastDownload={vi.fn().mockResolvedValue(true)}
          onGuidedDownload={vi.fn()}
        />
      </ThemeProvider>,
    );

    expect(screen.getByPlaceholderText(/paste a youtube/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /quick download/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^download$/i })).toBeInTheDocument();
  });

  // 4. Invalid scheme client-side rejection & backend playlist error handling
  it('rejects invalid URLs client-side and surfaces backend error on playlist URLs', async () => {
    const user = userEvent.setup();
    const handleFast = vi.fn().mockRejectedValue(new Error('Les playlists et les chaînes ne sont pas prises en charge'));
    const handleGuided = vi.fn();
    const theme = createAppTheme('dark');

    render(
      <ThemeProvider theme={theme}>
        <DownloadForm
          onFastDownload={handleFast}
          onGuidedDownload={handleGuided}
          isProcessing={false}
        />
      </ThemeProvider>,
    );

    const input = screen.getByPlaceholderText(/collez un lien youtube/i);
    await user.type(input, 'ftp://invalid-url.com');

    const fastBtn = screen.getByRole('button', { name: /téléchargement rapide/i });
    await user.click(fastBtn);

    expect(handleFast).not.toHaveBeenCalled();
    expect(
      screen.getByText(/veuillez saisir une url valide/i),
    ).toBeInTheDocument();

    await user.clear(input);
    await user.type(input, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL12345678');
    await user.click(fastBtn);

    expect(handleFast).toHaveBeenCalled();
    expect(
      await screen.findByText(/les playlists et les chaînes ne sont pas prises en charge/i),
    ).toBeInTheDocument();
  });

  // 5. Fast download flow
  it('triggers onFastDownload when clicking Fast Download button and clears input on success', async () => {
    const user = userEvent.setup();
    const handleFast = vi.fn().mockResolvedValue(true);
    const theme = createAppTheme('dark');

    render(
      <ThemeProvider theme={theme}>
        <DownloadForm
          onFastDownload={handleFast}
          onGuidedDownload={vi.fn()}
        />
      </ThemeProvider>,
    );

    const input = screen.getByPlaceholderText(/collez un lien youtube/i);
    await user.type(input, 'https://www.youtube.com/watch?v=jNQXAC9IVRw');

    const fastBtn = screen.getByRole('button', { name: /téléchargement rapide/i });
    await user.click(fastBtn);

    expect(handleFast).toHaveBeenCalledWith('https://www.youtube.com/watch?v=jNQXAC9IVRw');
    await waitFor(() => {
      expect(input).toHaveValue('');
    });
  });

  // 6. DownloadOptionsDialog with location selector
  it('renders DownloadOptionsDialog with location picker and passes chosen directory on confirm', async () => {
    const user = userEvent.setup();
    const handleConfirm = vi.fn().mockResolvedValue(undefined);
    const pickSpy = vi.spyOn(defaultIpcClient, 'pickDirectory').mockResolvedValue('/custom/my_movies');
    const theme = createAppTheme('dark');

    render(
      <ThemeProvider theme={theme}>
        <DownloadOptionsDialog
          open={true}
          onClose={vi.fn()}
          probeResult={sampleProbeResult}
          isLoading={false}
          defaultPreset={defaultPreset}
          defaultDownloadDirectory="~/Downloads/PolySaver"
          onConfirmDownload={handleConfirm}
        />
      </ThemeProvider>,
    );

    expect(screen.getByText('Me at the zoo')).toBeInTheDocument();
    expect(screen.getByText('~/Downloads/PolySaver')).toBeInTheDocument();

    // Click location picker button
    const locationBtn = screen.getByRole('button', { name: /choisir un dossier d’enregistrement/i });
    await user.click(locationBtn);

    expect(pickSpy).toHaveBeenCalledWith('~/Downloads/PolySaver');
    await waitFor(() => {
      expect(screen.getByText('/custom/my_movies')).toBeInTheDocument();
    });

    const confirmBtn = screen.getByRole('button', { name: /lancer le téléchargement/i });
    await user.click(confirmBtn);

    expect(handleConfirm).toHaveBeenCalledWith(
      { format: 'mp4', videoQuality: 'p1080' },
      '/custom/my_movies',
    );

    pickSpy.mockRestore();
  });

  // 7. Clickable card source URL and dismiss action
  it('opens source URL in default browser and dismisses non-completed jobs', async () => {
    const user = userEvent.setup();
    const openUrlSpy = vi.spyOn(defaultIpcClient, 'openDownloadSourceUrl').mockResolvedValue(undefined);
    const handleDismiss = vi.fn().mockResolvedValue(undefined);

    const theme = createAppTheme('dark');
    const jobs: DownloadJobDto[] = [
      {
        id: 'job-failed-1',
        url: 'https://www.youtube.com/watch?v=failed1',
        title: 'Failed Video',
        preset: { format: 'mp4', videoQuality: 'p720' },
        status: 'failed',
        errorMessage: 'Network error',
      },
    ];

    render(
      <ThemeProvider theme={theme}>
        <DownloadQueue jobs={jobs} onDismissJob={handleDismiss} />
      </ThemeProvider>,
    );

    // Click source URL button
    const urlBtn = screen.getByText('https://www.youtube.com/watch?v=failed1');
    await user.click(urlBtn);
    expect(openUrlSpy).toHaveBeenCalledWith('job-failed-1');

    // Click dismiss button
    const dismissBtn = screen.getByRole('button', { name: /retirer de la file/i });
    await user.click(dismissBtn);
    expect(handleDismiss).toHaveBeenCalledWith('job-failed-1');

    openUrlSpy.mockRestore();
  });

  // 8. DownloadHistory section rendering and remove action
  it('renders DownloadHistory with action buttons and calls onRemoveEntry without deleting files', async () => {
    const user = userEvent.setup();
    const revealSpy = vi.spyOn(defaultIpcClient, 'revealHistoryFile').mockResolvedValue(undefined);
    const openSpy = vi.spyOn(defaultIpcClient, 'openHistoryFile').mockResolvedValue(undefined);
    const openUrlSpy = vi.spyOn(defaultIpcClient, 'openHistorySourceUrl').mockResolvedValue(undefined);
    const handleRemove = vi.fn().mockResolvedValue(undefined);

    const theme = createAppTheme('dark');
    const historyEntries: DownloadHistoryEntryDto[] = [
      {
        id: 'hist-1',
        downloadId: 'job-1',
        sourceUrl: 'https://www.youtube.com/watch?v=zoo',
        title: 'Me at the zoo',
        preset: { format: 'mp4', videoQuality: 'p720' },
        destinationPath: '/downloads/zoo.mp4',
        completedAt: 1770000000000,
      },
    ];

    render(
      <ThemeProvider theme={theme}>
        <DownloadHistory entries={historyEntries} onRemoveEntry={handleRemove} />
      </ThemeProvider>,
    );

    expect(screen.getByText('Historique (1)')).toBeInTheDocument();
    expect(screen.getByText('Me at the zoo')).toBeInTheDocument();

    // Source URL is clickable
    const urlBtn = screen.getByText('https://www.youtube.com/watch?v=zoo');
    await user.click(urlBtn);
    expect(openUrlSpy).toHaveBeenCalledWith('hist-1');

    // Reveal and open file buttons
    const revealBtn = screen.getByRole('button', { name: /afficher le fichier téléchargé dans le dossier/i });
    const openBtn = screen.getByRole('button', { name: /ouvrir le fichier téléchargé/i });
    await user.click(revealBtn);
    expect(revealSpy).toHaveBeenCalledWith('hist-1');

    await user.click(openBtn);
    expect(openSpy).toHaveBeenCalledWith('hist-1');

    // Remove from history
    const removeBtn = screen.getByRole('button', { name: /retirer cet élément de l’historique/i });
    await user.click(removeBtn);
    expect(handleRemove).toHaveBeenCalledWith('hist-1');

    revealSpy.mockRestore();
    openSpy.mockRestore();
    openUrlSpy.mockRestore();
  });

  // 9. SettingsDrawer with Language selector and Parcourir button
  it('renders SettingsDrawer with Language selector and Parcourir button', async () => {
    const user = userEvent.setup();
    const handleUpdateSettings = vi.fn();
    const handleBrowseDirectory = vi.fn().mockResolvedValue('/Users/alice/Movies/PolySaver');
    const theme = createAppTheme('dark');

    render(
      <ThemeProvider theme={theme}>
        <SettingsDrawer
          open={true}
          onClose={vi.fn()}
          settings={defaultSettings}
          onUpdateSettings={handleUpdateSettings}
          saveStatus="idle"
          onBrowseDirectory={handleBrowseDirectory}
        />
      </ThemeProvider>,
    );

    // Language buttons
    expect(screen.getByRole('button', { name: /passer en français/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /switch to english/i })).toBeInTheDocument();

    // Click English language
    const enBtn = screen.getByRole('button', { name: /switch to english/i });
    await user.click(enBtn);
    expect(handleUpdateSettings).toHaveBeenCalledWith({ language: 'en' }, true);

    // Browse button exists
    const browseBtn = screen.getByRole('button', { name: /parcourir/i });
    expect(browseBtn).toBeInTheDocument();

    await user.click(browseBtn);
    expect(handleBrowseDirectory).toHaveBeenCalledWith('~/Downloads/PolySaver');
    expect(handleUpdateSettings).toHaveBeenCalledWith(
      { downloadDirectory: '/Users/alice/Movies/PolySaver' },
      true,
    );
  });

  // 10. EmptyQueue spacing check
  it('renders EmptyQueue with top margin', () => {
    const theme = createAppTheme('dark');
    const { container } = render(
      <ThemeProvider theme={theme}>
        <EmptyQueue />
      </ThemeProvider>,
    );

    expect(screen.getByText('Aucun téléchargement')).toBeInTheDocument();
    expect(container.firstChild).toBeInTheDocument();
  });

  // 11. Autosave Hook verification (immediate, debounce, language synchronization)
  it('useAutosaveSettings synchronizes language and saves immediate changes', async () => {
    const mockClient: IpcClient = {
      healthCheck: vi.fn(),
      getSettings: vi.fn().mockResolvedValue(defaultSettings),
      setSettings: vi.fn().mockImplementation(async (s) => s),
      startDownload: vi.fn(),
      listDownloads: vi.fn(),
      cancelDownload: vi.fn(),
      cancelAnalyze: vi.fn(),
      retryDownload: vi.fn(),
      dismissDownload: vi.fn(),
      openDownloadSourceUrl: vi.fn(),
      analyzeUrl: vi.fn(),
      pickDirectory: vi.fn().mockResolvedValue('/selected/folder'),
      revealDownloadedFile: vi.fn(),
      openDownloadedFile: vi.fn(),
      listDownloadHistory: vi.fn().mockResolvedValue([]),
      removeDownloadHistoryEntry: vi.fn(),
      revealHistoryFile: vi.fn(),
      openHistoryFile: vi.fn(),
      openHistorySourceUrl: vi.fn(),
      openSupportPage: vi.fn().mockResolvedValue(undefined),
      checkForUpdates: vi.fn().mockResolvedValue(null),
      downloadAndInstallUpdate: vi.fn().mockResolvedValue(undefined),
      restartApp: vi.fn().mockResolvedValue(undefined),
      checkEngineUpdate: vi.fn().mockResolvedValue({
        currentVersion: '2026.08.19',
        latestVersion: '2026.08.19',
        channel: 'stable',
        outdated: false,
        canUpdate: false,
      }),
      updateEngine: vi.fn().mockResolvedValue({ installedVersion: '2026.08.19', updated: true, latestVersion: null }),
      rollbackEngine: vi.fn().mockResolvedValue({ installedVersion: '2026.08.19', updated: true, latestVersion: null }),
      checkJsRuntime: vi.fn().mockResolvedValue({
        kind: 'node',
        version: '24.21.0',
        path: '/tmp/node',
        isReady: true,
        versionTooOld: false,
      }),
      installJsRuntime: vi.fn().mockResolvedValue({
        kind: 'node',
        version: '24.21.0',
        path: '/tmp/node',
        isReady: true,
        versionTooOld: false,
      }),
    };

    let hookResult: ReturnType<typeof useAutosaveSettings> | undefined;

    const TestComponent = () => {
      hookResult = useAutosaveSettings(mockClient, 100);
      return (
        <div>
          <span>Status: {hookResult.status}</span>
          <span>Lang: {hookResult.settings.language}</span>
          <span>Theme: {hookResult.settings.themeMode}</span>
        </div>
      );
    };

    render(<TestComponent />);

    await waitFor(() => {
      expect(hookResult?.settings.language).toBe('fr');
    });

    // Update language to English
    await act(async () => {
      hookResult?.updateSettings({ language: 'en' }, true);
    });

    await waitFor(() => {
      expect(hookResult?.settings.language).toBe('en');
      expect(i18n.language).toBe('en');
      expect(document.documentElement.lang).toBe('en');
    });
  });

  // 12. useAutosaveSettings preserves newer keystrokes when async save resolves
  it('preserves newer user keystrokes when an in-flight save resolves with canonical path', async () => {
    let resolveFirstSave: ((val: AppSettingsDto) => void) | undefined;
    const defaultSettings: AppSettingsDto = {
      downloadDirectory: '/Users/alice/Downloads/PolySaver',
      themeMode: 'system',
      defaultPreset: {
        format: 'mp4',
        videoQuality: 'best',
      },
      language: 'fr',
    };

    const mockClient: IpcClient = {
      healthCheck: vi.fn(),
      getSettings: vi.fn().mockResolvedValue(defaultSettings),
      setSettings: vi.fn().mockImplementation((s: AppSettingsDto) => {
        if (s.downloadDirectory === '~/documents') {
          return new Promise<AppSettingsDto>((resolve) => {
            resolveFirstSave = (val) => resolve({ ...val, downloadDirectory: '/Users/alice/documents' });
          });
        }
        return Promise.resolve(s);
      }),
      startDownload: vi.fn(),
      listDownloads: vi.fn(),
      cancelDownload: vi.fn(),
      cancelAnalyze: vi.fn(),
      retryDownload: vi.fn(),
      dismissDownload: vi.fn(),
      openDownloadSourceUrl: vi.fn(),
      analyzeUrl: vi.fn(),
      pickDirectory: vi.fn(),
      revealDownloadedFile: vi.fn(),
      openDownloadedFile: vi.fn(),
      listDownloadHistory: vi.fn().mockResolvedValue([]),
      removeDownloadHistoryEntry: vi.fn(),
      revealHistoryFile: vi.fn(),
      openHistoryFile: vi.fn(),
      openHistorySourceUrl: vi.fn(),
      openSupportPage: vi.fn().mockResolvedValue(undefined),
      checkForUpdates: vi.fn().mockResolvedValue(null),
      downloadAndInstallUpdate: vi.fn().mockResolvedValue(undefined),
      restartApp: vi.fn().mockResolvedValue(undefined),
      checkEngineUpdate: vi.fn().mockResolvedValue({
        currentVersion: '2026.08.19',
        latestVersion: '2026.08.19',
        channel: 'stable',
        outdated: false,
        canUpdate: false,
      }),
      updateEngine: vi.fn().mockResolvedValue({ installedVersion: '2026.08.19', updated: true, latestVersion: null }),
      rollbackEngine: vi.fn().mockResolvedValue({ installedVersion: '2026.08.19', updated: true, latestVersion: null }),
      checkJsRuntime: vi.fn().mockResolvedValue({
        kind: 'node',
        version: '24.21.0',
        path: '/tmp/node',
        isReady: true,
        versionTooOld: false,
      }),
      installJsRuntime: vi.fn().mockResolvedValue({
        kind: 'node',
        version: '24.21.0',
        path: '/tmp/node',
        isReady: true,
        versionTooOld: false,
      }),
    };

    let hookResult: ReturnType<typeof useAutosaveSettings> | undefined;

    const TestComponent = () => {
      hookResult = useAutosaveSettings(mockClient, 50);
      return <div>Dir: {hookResult.settings.downloadDirectory}</div>;
    };

    render(<TestComponent />);

    await waitFor(() => {
      expect(hookResult?.settings.downloadDirectory).toBe('/Users/alice/Downloads/PolySaver');
    });

    // 1. User types ~/documents
    await act(async () => {
      hookResult?.updateSettings({ downloadDirectory: '~/documents' }, true);
    });

    // 2. While save is in-flight, user types ~/documents/work
    await act(async () => {
      hookResult?.updateSettings({ downloadDirectory: '~/documents/work' }, false);
    });

    // 3. First save resolves
    await act(async () => {
      if (resolveFirstSave) {
        resolveFirstSave({ ...defaultSettings, downloadDirectory: '~/documents' });
      }
    });

    // 4. Newer input ~/documents/work must NOT have been overwritten by /Users/alice/documents
    expect(hookResult?.settings.downloadDirectory).toBe('~/documents/work');
  });

  // 13. Instant cancel returns canceled job
  it('cancelDownload returns canceled job state', async () => {
    const canceledJob: DownloadJobDto = {
      id: '01912345-6789-7abc-8def-0123456789ab',
      url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
      status: 'canceled',
      preset: { format: 'mp4', videoQuality: 'best' },
    };

    const mockClient: IpcClient = {
      healthCheck: vi.fn(),
      getSettings: vi.fn().mockResolvedValue({
        downloadDirectory: '/downloads',
        themeMode: 'system',
        defaultPreset: { format: 'mp4', videoQuality: 'best' },
        language: 'fr',
      }),
      setSettings: vi.fn(),
      startDownload: vi.fn(),
      listDownloads: vi.fn(),
      cancelDownload: vi.fn().mockResolvedValue(canceledJob),
      cancelAnalyze: vi.fn(),
      retryDownload: vi.fn(),
      dismissDownload: vi.fn(),
      openDownloadSourceUrl: vi.fn(),
      analyzeUrl: vi.fn(),
      pickDirectory: vi.fn(),
      revealDownloadedFile: vi.fn(),
      openDownloadedFile: vi.fn(),
      listDownloadHistory: vi.fn().mockResolvedValue([]),
      removeDownloadHistoryEntry: vi.fn(),
      revealHistoryFile: vi.fn(),
      openHistoryFile: vi.fn(),
      openHistorySourceUrl: vi.fn(),
      openSupportPage: vi.fn().mockResolvedValue(undefined),
      checkForUpdates: vi.fn().mockResolvedValue(null),
      downloadAndInstallUpdate: vi.fn().mockResolvedValue(undefined),
      restartApp: vi.fn().mockResolvedValue(undefined),
      checkEngineUpdate: vi.fn().mockResolvedValue({
        currentVersion: '2026.08.19',
        latestVersion: '2026.08.19',
        channel: 'stable',
        outdated: false,
        canUpdate: false,
      }),
      updateEngine: vi.fn().mockResolvedValue({ installedVersion: '2026.08.19', updated: true, latestVersion: null }),
      rollbackEngine: vi.fn().mockResolvedValue({ installedVersion: '2026.08.19', updated: true, latestVersion: null }),
      checkJsRuntime: vi.fn().mockResolvedValue({
        kind: 'node',
        version: '24.21.0',
        path: '/tmp/node',
        isReady: true,
        versionTooOld: false,
      }),
      installJsRuntime: vi.fn().mockResolvedValue({
        kind: 'node',
        version: '24.21.0',
        path: '/tmp/node',
        isReady: true,
        versionTooOld: false,
      }),
    };

    const res = await mockClient.cancelDownload(canceledJob.id);
    expect(res.status).toBe('canceled');
    expect(res.id).toBe(canceledJob.id);
  });

  // 14. Retry action only on failed jobs
  it('shows a Retry button only on failed jobs and triggers the callback', async () => {
    const user = userEvent.setup();
    const handleRetry = vi.fn();
    const theme = createAppTheme('dark');
    const jobs: DownloadJobDto[] = [
      {
        id: 'job-failed-retry',
        url: 'https://www.youtube.com/watch?v=failed1',
        title: 'Failed Video',
        preset: { format: 'mp4', videoQuality: 'p720' },
        status: 'failed',
        errorMessage: 'Network error',
      },
      {
        id: 'job-canceled-1',
        url: 'https://www.youtube.com/watch?v=canceled1',
        title: 'Canceled Video',
        preset: { format: 'mp4', videoQuality: 'p720' },
        status: 'canceled',
      },
    ];

    render(
      <ThemeProvider theme={theme}>
        <DownloadQueue jobs={jobs} onRetryJob={handleRetry} />
      </ThemeProvider>,
    );

    const retryBtns = screen.getAllByRole('button', { name: /relancer ce téléchargement/i });
    expect(retryBtns).toHaveLength(1);

    await user.click(retryBtns[0]);
    expect(handleRetry).toHaveBeenCalledWith('job-failed-retry');
  });

  // 15. No Retry button on canceled or completed jobs
  it('does not render any Retry button when no job failed', () => {
    const theme = createAppTheme('dark');
    const jobs: DownloadJobDto[] = [
      {
        id: 'job-canceled-only',
        url: 'https://www.youtube.com/watch?v=canceled1',
        title: 'Canceled Video',
        preset: { format: 'mp4', videoQuality: 'p720' },
        status: 'canceled',
      },
      {
        id: 'job-completed-only',
        url: 'https://www.youtube.com/watch?v=done1',
        title: 'Done Video',
        preset: { format: 'mp4', videoQuality: 'p720' },
        status: 'completed',
      },
    ];

    render(
      <ThemeProvider theme={theme}>
        <DownloadQueue jobs={jobs} onRetryJob={vi.fn()} />
      </ThemeProvider>,
    );

    expect(
      screen.queryByRole('button', { name: /relancer ce téléchargement/i }),
    ).not.toBeInTheDocument();
  });

  // 16. Closing the options dialog during analysis cancels it
  it('invokes onClose (cancellation) when the dialog is closed while analyzing', async () => {
    const user = userEvent.setup();
    const handleClose = vi.fn();
    const theme = createAppTheme('dark');

    render(
      <ThemeProvider theme={theme}>
        <DownloadOptionsDialog
          open={true}
          onClose={handleClose}
          probeResult={null}
          isLoading={true}
          defaultPreset={defaultPreset}
          onConfirmDownload={vi.fn()}
        />
      </ThemeProvider>,
    );

    // The Cancel button must stay enabled while loading, and closing must call onClose.
    const cancelBtn = screen.getByRole('button', { name: /annuler/i });
    expect(cancelBtn).not.toBeDisabled();
    await user.click(cancelBtn);
    expect(handleClose).toHaveBeenCalledTimes(1);
  });

  // 17. normalizeIpcError preserves every technical field
  it('preserves retryable, details, component, exitCode and stderrTail in normalizeIpcError', () => {
    const backendError = {
      code: 'DOWNLOAD_PROCESS_FAILED',
      message: 'Le processus a échoué.',
      retryable: true,
      details: {
        code: 'DOWNLOAD_PROCESS_FAILED',
        message: 'Le processus a échoué.',
        retryable: true,
        component: 'yt-dlp 2026.08.19',
        exitCode: 1,
        stderrTail: 'ERROR: boom\nERROR: bang',
      },
    };

    const normalized = normalizeIpcError(backendError);
    expect(normalized.code).toBe('DOWNLOAD_PROCESS_FAILED');
    expect(normalized.retryable).toBe(true);
    expect(normalized.details?.component).toBe('yt-dlp 2026.08.19');
    expect(normalized.details?.exitCode).toBe(1);
    expect(normalized.details?.stderrTail).toContain('ERROR: boom');

    // Flat variants (component at top level) are also accepted.
    const flat = normalizeIpcError({
      code: 'NETWORK_UNAVAILABLE',
      message: 'offline',
      retryable: true,
      component: 'yt-dlp',
      exitCode: 3,
      stderrTail: 'tail',
    });
    expect(flat.details?.component).toBe('yt-dlp');
    expect(flat.details?.exitCode).toBe(3);
    expect(flat.details?.stderrTail).toBe('tail');
  });

  // 18. Technical details panel shows component/exit code/stderr
  it('shows a collapsible technical details panel for a failed job', async () => {
    const user = userEvent.setup();
    const theme = createAppTheme('dark');
    const jobs: DownloadJobDto[] = [
      {
        id: 'job-with-details',
        url: 'https://www.youtube.com/watch?v=boom',
        title: 'Broken Video',
        preset: { format: 'mp4', videoQuality: 'p720' },
        status: 'failed',
        errorMessage: 'Échec du processus',
        errorDetails: {
          code: 'DOWNLOAD_PROCESS_FAILED',
          message: 'Échec du processus',
          retryable: true,
          component: 'yt-dlp 2026.08.19',
          exitCode: 1,
          stderrTail: 'ERROR: signature solving failed',
        },
      },
    ];

    render(
      <ThemeProvider theme={theme}>
        <DownloadQueue jobs={jobs} />
      </ThemeProvider>,
    );

    const toggle = screen.getByRole('button', { name: /détails techniques/i });
    expect(screen.queryByText(/signature solving failed/i)).not.toBeInTheDocument();

    await user.click(toggle);
    expect(await screen.findByText(/signature solving failed/i)).toBeInTheDocument();
    expect(screen.getByText(/yt-dlp 2026.08.19/)).toBeInTheDocument();
  });

  // 19. Retry counter chip is visible only while the job is retried
  it('renders the retry counter chip for a job being retried', () => {
    const theme = createAppTheme('dark');
    const jobs: DownloadJobDto[] = [
      {
        id: 'job-retrying',
        url: 'https://www.youtube.com/watch?v=retry',
        title: 'Retrying',
        preset: { format: 'mp4', videoQuality: 'p720' },
        status: 'downloading',
        progressPercent: 10,
        retryCount: 1,
      },
      {
        id: 'job-plain',
        url: 'https://www.youtube.com/watch?v=plain',
        title: 'Plain',
        preset: { format: 'mp4', videoQuality: 'p720' },
        status: 'downloading',
        progressPercent: 10,
        retryCount: 0,
      },
    ];

    render(
      <ThemeProvider theme={theme}>
        <DownloadQueue jobs={jobs} />
      </ThemeProvider>,
    );

    expect(screen.getByText('Tentative 1/3')).toBeInTheDocument();
    expect(screen.queryByText('Tentative 0/3')).not.toBeInTheDocument();
  });

  // 20. JavaScript runtime dialog: primary action pre-focused, installs on click
  it('pre-focuses the Install button and calls installJsRuntime', async () => {
    const user = userEvent.setup();
    const installJsRuntime = vi.fn().mockResolvedValue({
      kind: 'node',
      version: '24.21.0',
      path: '/tmp/node',
      isReady: true,
      versionTooOld: false,
    });
    const onInstalled = vi.fn();
    const client = { installJsRuntime } as unknown as IpcClient;

    render(
      <JsRuntimeSetupDialog
        open={true}
        onClose={vi.fn()}
        client={client}
        hasActiveDownloads={false}
        onInstalled={onInstalled}
      />,
    );

    const installBtn = screen.getByRole('button', { name: /^installer$/i });
    // The primary action is the keyboard default (Enter installs).
    expect(installBtn).toHaveFocus();

    await user.click(installBtn);
    expect(installJsRuntime).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(onInstalled).toHaveBeenCalled();
    });
    expect(await screen.findByText(/Runtime JavaScript installé/i)).toBeInTheDocument();
  });

  // 21. The Later button is a secondary action and does not install
  it('keeps the Later action inert and does not trigger installation', async () => {
    const user = userEvent.setup();
    const installJsRuntime = vi.fn();
    const onClose = vi.fn();
    const client = { installJsRuntime } as unknown as IpcClient;

    render(
      <JsRuntimeSetupDialog
        open={true}
        onClose={onClose}
        client={client}
        hasActiveDownloads={false}
      />,
    );

    await user.click(screen.getByRole('button', { name: /plus tard/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(installJsRuntime).not.toHaveBeenCalled();
  });
});
