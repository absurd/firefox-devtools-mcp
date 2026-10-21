/**
 * Unit tests for FirefoxCore module
 */

import { join } from 'node:path';
import { MCP_PROFILE_DIR_NAME } from '@/firefox/profile.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FirefoxCore } from '@/firefox/core.js';
import type { FirefoxLaunchOptions } from '@/firefox/types.js';

describe('FirefoxCore', () => {
  describe('constructor', () => {
    it('should create instance with options', () => {
      const options: FirefoxLaunchOptions = { headless: true };

      const core = new FirefoxCore(options);
      expect(core).toBeInstanceOf(FirefoxCore);
    });
  });

  describe('getCurrentContextId', () => {
    it('should return null when not connected', () => {
      const core = new FirefoxCore({ headless: true });
      expect(core.getCurrentContextId()).toBe(null);
    });
  });

  describe('setCurrentContextId', () => {
    it('should set context ID', () => {
      const core = new FirefoxCore({ headless: true });
      const contextId = 'test-context-123';

      core.setCurrentContextId(contextId);
      expect(core.getCurrentContextId()).toBe(contextId);
    });

    it('should update context ID', () => {
      const core = new FirefoxCore({ headless: true });

      core.setCurrentContextId('context-1');
      expect(core.getCurrentContextId()).toBe('context-1');

      core.setCurrentContextId('context-2');
      expect(core.getCurrentContextId()).toBe('context-2');
    });
  });

  describe('getDriver', () => {
    it('should throw error when not connected', () => {
      const core = new FirefoxCore({ headless: true });
      expect(() => core.getDriver()).toThrow('Driver not connected');
    });
  });

  describe('ensureConnected', () => {
    it('should return false when driver is null', async () => {
      const core = new FirefoxCore({ headless: true });
      const connected = await core.ensureConnected();
      expect(connected).toBe(false);
    });

    it('should return true when the current tab is still available', async () => {
      const switchTo = vi.fn();
      const core = new FirefoxCore({ headless: true });
      (core as any).driver = {
        getWindowHandle: vi.fn().mockResolvedValue('current-tab'),
        getAllWindowHandles: vi.fn().mockResolvedValue(['other-tab', 'current-tab']),
        switchTo,
      };
      core.setCurrentContextId('current-tab');

      const connected = await core.ensureConnected();

      expect(connected).toBe(true);
      expect(switchTo).not.toHaveBeenCalled();
      expect(core.getCurrentContextId()).toBe('current-tab');
    });

    describe('when the selected tab is no longer listed', () => {
      function createClosedTabCore(remaining: string[], getWindowHandle?: () => unknown) {
        const switchTo = vi.fn();
        const core = new FirefoxCore({ headless: true });
        (core as any).driver = {
          getWindowHandle: vi.fn(
            getWindowHandle ?? (() => Promise.reject(new Error('no such window')))
          ),
          getAllWindowHandles: vi.fn().mockResolvedValue(remaining),
          switchTo,
        };
        (core as any).knownHandles = ['tab-1', 'tab-2'];
        core.setCurrentContextId('tab-2');
        return { core, switchTo };
      }

      it('should leave no tab selected instead of switching to another tab', async () => {
        const { core, switchTo } = createClosedTabCore(['tab-1']);

        expect(await core.ensureConnected()).toBe(true);
        expect(switchTo).not.toHaveBeenCalled();
        expect(core.getCurrentContextId()).toBe(null);
      });

      it('should not follow a tab that replaced it', async () => {
        // For example a tab the user opened, or one an extension reopened.
        const { core, switchTo } = createClosedTabCore(['tab-1', 'tab-3']);

        expect(await core.ensureConnected()).toBe(true);
        expect(switchTo).not.toHaveBeenCalled();
        expect(core.getCurrentContextId()).toBe(null);
      });

      it('should treat a known tab as closed even if its handle still answers', async () => {
        const { core } = createClosedTabCore(['tab-1'], () => Promise.resolve('tab-2'));

        expect(await core.ensureConnected()).toBe(true);
        expect(core.getCurrentContextId()).toBe(null);
      });

      it('should not open a new tab when all tabs have been closed', async () => {
        const { core, switchTo } = createClosedTabCore([]);

        expect(await core.ensureConnected()).toBe(true);
        expect(switchTo).not.toHaveBeenCalled();
        expect(core.getCurrentContextId()).toBe(null);
      });

      it('should leave no tab selected when a tab opened since the last check is gone', async () => {
        const { core } = createClosedTabCore(['tab-1', 'tab-2']);
        core.setCurrentContextId('tab-new');

        expect(await core.ensureConnected()).toBe(true);
        expect(core.getCurrentContextId()).toBe(null);
      });
    });

    it('should leave no context selected when a selected privileged context is gone', async () => {
      const switchTo = vi.fn();
      const core = new FirefoxCore({ headless: true });
      (core as any).driver = {
        getWindowHandle: vi.fn().mockRejectedValue(new Error('no such window')),
        getAllWindowHandles: vi.fn().mockResolvedValue(['tab-1']),
        switchTo,
      };
      (core as any).knownHandles = ['tab-1'];
      core.setCurrentContextId('chrome-window');

      expect(await core.ensureConnected()).toBe(true);
      expect(switchTo).not.toHaveBeenCalled();
      expect(core.getCurrentContextId()).toBe(null);
    });

    it('should keep a selected privileged context that is still open', async () => {
      const core = new FirefoxCore({ headless: true });
      (core as any).driver = {
        getWindowHandle: vi.fn().mockResolvedValue('chrome-window'),
        getAllWindowHandles: vi.fn().mockResolvedValue(['tab-1']),
      };
      (core as any).knownHandles = ['tab-1'];
      core.setCurrentContextId('chrome-window');

      expect(await core.ensureConnected()).toBe(true);
      expect(core.getCurrentContextId()).toBe('chrome-window');
    });

    it('should return false when listing tabs fails', async () => {
      const core = new FirefoxCore({ headless: true });
      (core as any).driver = {
        getWindowHandle: vi.fn().mockRejectedValue(new Error('no such window')),
        getAllWindowHandles: vi.fn().mockRejectedValue(new Error('not responsive')),
      };
      core.setCurrentContextId('tab-1');

      const connected = await core.ensureConnected();

      expect(connected).toBe(false);
    });
  });

  describe('close', () => {
    it('should call quit() and null driver when quit() succeeds', async () => {
      const quit = vi.fn().mockResolvedValue(undefined);
      const onQuit = vi.fn().mockResolvedValue(undefined);
      const core = new FirefoxCore({ headless: true });
      (core as any).driver = { quit, onQuit_: onQuit };
      core.setCurrentContextId('ctx-1');

      await core.close();

      expect(quit).toHaveBeenCalledTimes(1);
      expect(onQuit).not.toHaveBeenCalled();
      expect(core.getCurrentContextId()).toBe(null);
      expect(() => core.getDriver()).toThrow('Driver not connected');
    });

    it('should call onQuit_() when quit() times out', async () => {
      vi.useFakeTimers();
      try {
        const onQuit = vi.fn().mockResolvedValue(undefined);
        const core = new FirefoxCore({ headless: true });
        (core as any).driver = {
          quit: vi.fn().mockReturnValue(new Promise(() => {})),
          onQuit_: onQuit,
        };
        core.setCurrentContextId('ctx-1');

        const closePromise = core.close();

        await vi.advanceTimersByTimeAsync(5500);
        await closePromise;

        expect(onQuit).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('should call onQuit_() when quit() rejects', async () => {
      const onQuit = vi.fn().mockResolvedValue(undefined);
      const core = new FirefoxCore({ headless: true });
      (core as any).driver = {
        quit: vi.fn().mockRejectedValue(new Error('session not found')),
        onQuit_: onQuit,
      };
      core.setCurrentContextId('ctx-1');

      await core.close();

      expect(onQuit).toHaveBeenCalled();
    });

    it('should be idempotent with driver — second call is a no-op', async () => {
      const quit = vi.fn().mockResolvedValue(undefined);
      const onQuit = vi.fn().mockResolvedValue(undefined);
      const core = new FirefoxCore({ headless: true });
      (core as any).driver = { quit, onQuit_: onQuit };
      core.setCurrentContextId('ctx-1');

      await core.close();
      await core.close();

      expect(quit).toHaveBeenCalledTimes(1);
      expect(onQuit).not.toHaveBeenCalled();
    });

    it('should be idempotent without driver — returns without error', async () => {
      const core = new FirefoxCore({ headless: true });
      await core.close();
      await expect(core.close()).resolves.toBeUndefined();
    });

    it('should close BiDi WebSocket and clear the reference', async () => {
      const bidiClose = vi.fn();
      const webdriver = {
        quit: vi.fn().mockResolvedValue(undefined),
        _bidiConnection: { close: bidiClose },
      };
      const core = new FirefoxCore({ headless: true });
      (core as any).driver = webdriver;

      await core.close();

      expect(bidiClose).toHaveBeenCalled();
      expect(webdriver._bidiConnection).toBeUndefined();
    });

    it('should swallow BiDi close errors and continue cleanup', async () => {
      const webdriver = {
        quit: vi.fn().mockResolvedValue(undefined),
        _bidiConnection: {
          close: vi.fn().mockImplementation(() => {
            throw new Error('ws dead');
          }),
        },
      };
      const core = new FirefoxCore({ headless: true });
      (core as any).driver = webdriver;
      core.setCurrentContextId('ctx-1');

      await core.close();

      expect(webdriver._bidiConnection).toBeUndefined();
    });

    it('should restore env vars and clear state fields', async () => {
      const savedNewKey = process.env.FIREFOX_MCP_TEST_NEWKEY;
      const savedExisting = process.env.FIREFOX_MCP_TEST_EXISTING;
      try {
        const core = new FirefoxCore({ headless: true });
        (core as any).driver = {
          quit: vi.fn().mockResolvedValue(undefined),
        };
        core.setCurrentContextId('ctx-1');
        (core as any).logFilePath = '/tmp/test.log';
        (core as any).profileWarning = 'test warning';
        (core as any).logFileFd = 42;
        (core as any).originalEnv = {
          FIREFOX_MCP_TEST_NEWKEY: undefined,
          FIREFOX_MCP_TEST_EXISTING: 'oldvalue',
        };
        process.env.FIREFOX_MCP_TEST_NEWKEY = 'was-set-by-connect';
        process.env.FIREFOX_MCP_TEST_EXISTING = 'overwritten-by-connect';

        await core.close();

        expect(core.getCurrentContextId()).toBe(null);
        expect((core as any).logFilePath).toBeUndefined();
        expect((core as any).profileWarning).toBeNull();
        expect((core as any).logFileFd).toBeUndefined();
        expect((core as any).originalEnv).toEqual({});
        expect('FIREFOX_MCP_TEST_NEWKEY' in process.env).toBe(false);
        expect(process.env.FIREFOX_MCP_TEST_EXISTING).toBe('oldvalue');
      } finally {
        if (savedNewKey === undefined) {
          delete process.env.FIREFOX_MCP_TEST_NEWKEY;
        } else {
          process.env.FIREFOX_MCP_TEST_NEWKEY = savedNewKey;
        }
        if (savedExisting === undefined) {
          delete process.env.FIREFOX_MCP_TEST_EXISTING;
        } else {
          process.env.FIREFOX_MCP_TEST_EXISTING = savedExisting;
        }
      }
    });
  });
});

describe('FirefoxCore connect() Android app data wipe opt-in', () => {
  it('should refuse to launch on Android without androidWipeAppData', async () => {
    const core = new FirefoxCore({ androidDevice: 'auto' });

    await expect(core.connect()).rejects.toThrow(
      /wipes all data of org\.mozilla\.firefox.*--android-wipe-app-data/s
    );
  });

  it('should name the target package in the error', async () => {
    const core = new FirefoxCore({
      androidDevice: 'emulator-5554',
      androidPackage: 'org.mozilla.fenix',
    });

    await expect(core.connect()).rejects.toThrow(/wipes all data of org\.mozilla\.fenix/);
  });
});

// Tests for connect() behavior with mocked Selenium
describe('FirefoxCore connect() profile handling', () => {
  // Mock selenium-webdriver/firefox.js at module level
  const mockAddArguments = vi.fn();
  const mockSetProfile = vi.fn();
  const mockEnableBidi = vi.fn();
  const mockSetBinary = vi.fn();
  const mockWindowSize = vi.fn();
  const mockSetAcceptInsecureCerts = vi.fn();
  const mockSetStdio = vi.fn();
  const mockServiceBuilderCtor = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();

    vi.doMock('selenium-webdriver/firefox.js', () => ({
      default: {
        Options: class {
          enableBidi = mockEnableBidi;
          addArguments = mockAddArguments;
          setProfile = mockSetProfile;
          setBinary = mockSetBinary;
          windowSize = mockWindowSize;
          setAcceptInsecureCerts = mockSetAcceptInsecureCerts;
        },
        ServiceBuilder: class {
          constructor(...args: unknown[]) {
            mockServiceBuilderCtor(...args);
          }
          setStdio = mockSetStdio;
          addArguments = vi.fn();
        },
      },
    }));

    vi.doMock('selenium-webdriver', () => ({
      Builder: class {
        forBrowser = vi.fn().mockReturnThis();
        setFirefoxOptions = vi.fn().mockReturnThis();
        setFirefoxService = vi.fn().mockReturnThis();
        build = vi.fn().mockResolvedValue({
          getCapabilities: vi.fn(() => ({ get: vi.fn(() => '123.4') })),
          getWindowHandle: vi.fn().mockResolvedValue('mock-context-id'),
          getAllWindowHandles: vi.fn().mockResolvedValue(['mock-context-id']),
          get: vi.fn().mockResolvedValue(undefined),
        });
      },
      Browser: { FIREFOX: 'firefox' },
    }));

    // Mock node:fs so profile.ts doesn't touch the real filesystem.
    // existsSync returns true for geckodriver paths so findGeckodriver() succeeds.
    vi.doMock('node:fs', () => ({
      existsSync: vi.fn((p: unknown) => String(p).includes('geckodriver')),
      mkdirSync: vi.fn(),
      copyFileSync: vi.fn(),
      writeFileSync: vi.fn(),
      openSync: vi.fn().mockReturnValue(3),
      closeSync: vi.fn(),
    }));
  });

  it('should pass the MCP-specific profile subfolder via --profile argument instead of setProfile', async () => {
    const { FirefoxCore } = await import('@/firefox/core.js');

    const profilePath = '/path/to/test/profile';
    const core = new FirefoxCore({
      headless: true,
      profilePath,
    });

    await core.connect();

    // Assert: setProfile should NOT be called (it copies to temp dir)
    expect(mockSetProfile).not.toHaveBeenCalled();

    // The MCP uses a dedicated subfolder, not the raw profilePath
    expect(mockAddArguments).toHaveBeenCalledWith(
      '--profile',
      join('/path/to/test/profile', MCP_PROFILE_DIR_NAME)
    );
  });

  // Bug 2062055 and its follow-up. Giving the DriverService an executable also
  // opts out of Selenium Manager resolving the Firefox binary, so the explicit
  // path is only correct where Selenium Manager cannot run.
  describe('geckodriver resolution', () => {
    const platform = process.platform;
    const arch = process.arch;

    const setPlatform = (value: NodeJS.Platform, archValue: string) => {
      Object.defineProperty(process, 'platform', { value, configurable: true });
      Object.defineProperty(process, 'arch', { value: archValue, configurable: true });
    };

    afterEach(() => {
      setPlatform(platform, arch);
    });

    it.each([
      ['win32', 'x64'],
      ['linux', 'arm64'],
    ] as const)(
      'resolves geckodriver explicitly on %s/%s, where Selenium Manager cannot',
      async (osName, archName) => {
        setPlatform(osName, archName);
        const { FirefoxCore } = await import('@/firefox/core.js');

        await new FirefoxCore({ headless: true }).connect();

        expect(mockServiceBuilderCtor).toHaveBeenCalledTimes(1);
        const [geckodriverPath] = mockServiceBuilderCtor.mock.calls[0] as [unknown];
        expect(typeof geckodriverPath).toBe('string');
        expect(String(geckodriverPath)).toContain('geckodriver');
      }
    );

    it.each([
      ['linux', 'x64'],
      ['darwin', 'arm64'],
    ] as const)(
      'leaves the service executable unset on %s/%s, so Selenium Manager still finds Firefox',
      async (osName, archName) => {
        setPlatform(osName, archName);
        const { FirefoxCore } = await import('@/firefox/core.js');

        await new FirefoxCore({ headless: true }).connect();

        expect(mockServiceBuilderCtor).toHaveBeenCalledTimes(1);
        expect(mockServiceBuilderCtor.mock.calls[0]).toHaveLength(0);
      }
    );
  });
});

describe('FirefoxCore connect() binary lookup failure', () => {
  // Verbatim geckodriver wording; the capability name is the stable part.
  const geckodriverMessage =
    'Expected browser binary location, but unable to find binary in default location, ' +
    "no 'moz:firefoxOptions.binary' capability provided, and no binary flag set on the command line";

  function mockFailingBuild(message: string): void {
    vi.doMock('selenium-webdriver/firefox.js', () => ({
      default: {
        Options: class {
          enableBidi = vi.fn();
          addArguments = vi.fn();
          setBinary = vi.fn();
          windowSize = vi.fn();
          setAcceptInsecureCerts = vi.fn();
        },
        ServiceBuilder: class {
          setStdio = vi.fn();
          addArguments = vi.fn();
        },
      },
    }));

    vi.doMock('selenium-webdriver', () => ({
      Builder: class {
        forBrowser = vi.fn().mockReturnThis();
        setFirefoxOptions = vi.fn().mockReturnThis();
        setFirefoxService = vi.fn().mockReturnThis();
        build = vi.fn().mockRejectedValue(new Error(message));
      },
      Browser: { FIREFOX: 'firefox' },
    }));

    vi.doMock('node:fs', () => ({
      existsSync: vi.fn((p: unknown) => String(p).includes('geckodriver')),
      mkdirSync: vi.fn(),
      copyFileSync: vi.fn(),
      writeFileSync: vi.fn(),
      openSync: vi.fn().mockReturnValue(3),
      closeSync: vi.fn(),
    }));

    vi.doMock('@/firefox/windows-binary.js', () => ({
      findFirefoxBinaryWindows: vi.fn(() => null),
    }));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('points at --firefox-path when geckodriver found no binary', async () => {
    mockFailingBuild(geckodriverMessage);
    const { FirefoxCore } = await import('@/firefox/core.js');

    const core = new FirefoxCore({ headless: true });

    await expect(core.connect()).rejects.toThrow(
      /--firefox-path[\s\S]*Original error: Expected browser binary location/
    );
  });

  it('passes other launch failures through unchanged', async () => {
    const original = 'Process unexpectedly closed with status 1';
    mockFailingBuild(original);
    const { FirefoxCore } = await import('@/firefox/core.js');

    const core = new FirefoxCore({ headless: true });

    await expect(core.connect()).rejects.toThrow(original);
    await expect(core.connect()).rejects.not.toThrow('--firefox-path');
  });
});
