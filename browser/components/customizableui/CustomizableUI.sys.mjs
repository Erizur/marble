/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";
import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { SearchWidgetTracker } from "resource:///modules/SearchWidgetTracker.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  AddonManager: "resource://gre/modules/AddonManager.sys.mjs",
  AddonManagerPrivate: "resource://gre/modules/AddonManager.sys.mjs",
  BrowserUsageTelemetry: "resource:///modules/BrowserUsageTelemetry.sys.mjs",
  CustomizableWidgets: "resource:///modules/CustomizableWidgets.sys.mjs",
  HomePage: "resource:///modules/HomePage.sys.mjs",
  PanelMultiView: "resource:///modules/PanelMultiView.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  ShortcutUtils: "resource://gre/modules/ShortcutUtils.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "gWidgetsBundle", function () {
  const kUrl =
    "chrome://browser/locale/customizableui/customizableWidgets.properties";
  return Services.strings.createBundle(kUrl);
});

const kDefaultThemeID = "default-theme@mozilla.org";

const kSpecialWidgetPfx = "customizableui-special-";

const kPrefCustomizationState = "browser.uiCustomization.state";
const kPrefCustomizationAutoAdd = "browser.uiCustomization.autoAdd";
const kPrefCustomizationDebug = "browser.uiCustomization.debug";
const kPrefDrawInTitlebar = "browser.tabs.inTitlebar";
const kPrefUIDensity = "browser.uidensity";
const kPrefAutoTouchMode = "browser.touchmode.auto";
const kPrefAutoHideDownloadsButton = "browser.download.autohideButton";
const kPrefProtonToolbarVersion = "browser.proton.toolbar.version";
const kPrefHomeButtonUsed = "browser.engagement.home-button.has-used";
const kPrefLibraryButtonUsed = "browser.engagement.library-button.has-used";
const kPrefSidebarButtonUsed = "browser.engagement.sidebar-button.has-used";

const kExpectedWindowURL = AppConstants.BROWSER_CHROME_URL;

var gDefaultTheme;
var gSelectedTheme;

/**
 * The keys are the handlers that are fired when the event type (the value)
 * is fired on the subview. A widget that provides a subview has the option
 * of providing onViewShowing and onViewHiding event handlers.
 */
const kSubviewEvents = ["ViewShowing", "ViewHiding"];

/**
 * The current version. We can use this to auto-add new default widgets as necessary.
 * (would be const but isn't because of testing purposes)
 */
var kVersion = 20;

/**
 * Buttons removed from built-ins by version they were removed. kVersion must be
 * bumped any time a new id is added to this. Use the button id as key, and
 * version the button is removed in as the value.  e.g. "pocket-button": 5
 */
var ObsoleteBuiltinButtons = {
  "feed-button": 15,
};

/**
 * gPalette is a map of every widget that CustomizableUI.sys.mjs knows about, keyed
 * on their IDs.
 */
var gPalette = new Map();

/**
 * gAreas maps area IDs to Sets of properties about those areas. An area is a
 * place where a widget can be put.
 */
var gAreas = new Map();

/**
 * gPlacements maps area IDs to Arrays of widget IDs, indicating that the widgets
 * are placed within that area (either directly in the area node, or in the
 * customizationTarget of the node).
 */
var gPlacements = new Map();

/**
 * gFuturePlacements represent placements that will happen for areas that have
 * not yet loaded (due to lazy-loading). This can occur when add-ons register
 * widgets.
 */
var gFuturePlacements = new Map();

var gSupportedWidgetTypes = new Set([
  // A button that does a command.
  "button",

  // A button that opens a view in a panel (or in a subview of the panel).
  "view",

  // A combination of the above, which looks different depending on whether it's
  // located in the toolbar or in the panel: When located in the toolbar, shown
  // as a combined item of a button and a dropmarker button. The button triggers
  // the command and the dropmarker button opens the view. When located in the
  // panel, shown as one item which opens the view, and the button command
  // cannot be triggered separately.
  "button-and-view",

  // A custom widget that defines its own markup.
  "custom",
]);

/**
 * gPanelsForWindow is a list of known panels in a window which we may need to close
 * should command events fire which target them.
 */
var gPanelsForWindow = new WeakMap();

/**
 * gSeenWidgets remembers which widgets the user has seen for the first time
 * before. This way, if a new widget is created, and the user has not seen it
 * before, it can be put in its default location. Otherwise, it remains in the
 * palette.
 */
var gSeenWidgets = new Set();

/**
 * gDirtyAreaCache is a set of area IDs for areas where items have been added,
 * moved or removed at least once. This set is persisted, and is used to
 * optimize building of toolbars in the default case where no toolbars should
 * be "dirty".
 */
var gDirtyAreaCache = new Set();

/**
 * gPendingBuildAreas is a map from area IDs to map from build nodes to their
 * existing children at the time of node registration, that are waiting
 * for the area to be registered
 */
var gPendingBuildAreas = new Map();

var gSavedState = null;
var gRestoring = false;
var gDirty = false;
var gInBatchStack = 0;
var gResetting = false;
var gUndoResetting = false;

/**
 * gBuildAreas maps area IDs to actual area nodes within browser windows.
 */
var gBuildAreas = new Map();

/**
 * gBuildWindows is a map of windows that have registered build areas, mapped
 * to a Set of known toolboxes in that window.
 */
var gBuildWindows = new Map();

var gNewElementCount = 0;
var gGroupWrapperCache = new Map();
var gSingleWrapperCache = new WeakMap();
var gListeners = new Set();

var gUIStateBeforeReset = {
  uiCustomizationState: null,
  drawInTitlebar: null,
  currentTheme: null,
  uiDensity: null,
  autoTouchMode: null,
};

XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "gDebuggingEnabled",
  kPrefCustomizationDebug,
  false,
  (pref, oldVal, newVal) => {
    if (typeof lazy.log != "undefined") {
      lazy.log.maxLogLevel = newVal ? "all" : "log";
    }
  }
);

XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "resetPBMToolbarButtonEnabled",
  "browser.privatebrowsing.resetPBM.enabled",
  false
);

ChromeUtils.defineLazyGetter(lazy, "log", () => {
  let { ConsoleAPI } = ChromeUtils.importESModule(
    "resource://gre/modules/Console.sys.mjs"
  );
  let consoleOptions = {
    maxLogLevel: lazy.gDebuggingEnabled ? "all" : "log",
    prefix: "CustomizableUI",
  };
  return new ConsoleAPI(consoleOptions);
});

var CustomizableUIInternal = {
  initialize() {
    lazy.log.debug("Initializing");

    lazy.AddonManagerPrivate.databaseReady.then(async () => {
      lazy.AddonManager.addAddonListener(this);

      let addons = await lazy.AddonManager.getAddonsByTypes(["theme"]);
      gDefaultTheme = addons.find(addon => addon.id == kDefaultThemeID);
      gSelectedTheme = addons.find(addon => addon.isActive) || gDefaultTheme;
    });

    this.addListener(this);
    this._defineBuiltInWidgets();
    this.loadSavedState();
    this._updateForNewVersion();
    this._updateForNewProtonVersion();
    this._markObsoleteBuiltinButtonsSeen();

    this.registerArea(
      CustomizableUI.AREA_FIXED_OVERFLOW_PANEL,
      {
        type: CustomizableUI.TYPE_PANEL,
        defaultPlacements: [],
        anchor: "nav-bar-overflow-button",
      },
      true
    );

    this.registerArea(
      CustomizableUI.AREA_ADDONS,
      {
        type: CustomizableUI.TYPE_PANEL,
        defaultPlacements: [],
        anchor: "unified-extensions-button",
      },
      false
    );

    let navbarPlacements = [
      "back-button",
      "forward-button",
      "stop-reload-button",
      "home-button",
      "spring",
      "urlbar-container",
      "spring",
      "save-to-pocket-button",
      "downloads-button",
      "library-button",
      AppConstants.MOZ_DEV_EDITION ? "developer-button" : null,
      "sidebar-button",
      "fxa-toolbar-menu-button",
      lazy.resetPBMToolbarButtonEnabled ? "reset-pbm-toolbar-button" : null,
    ].filter(name => name);

    this.registerArea(
      CustomizableUI.AREA_NAVBAR,
      {
        type: CustomizableUI.TYPE_TOOLBAR,
        overflowable: true,
        defaultPlacements: navbarPlacements,
        defaultCollapsed: false,
      },
      true
    );

    if (AppConstants.MENUBAR_CAN_AUTOHIDE) {
      this.registerArea(
        CustomizableUI.AREA_MENUBAR,
        {
          type: CustomizableUI.TYPE_TOOLBAR,
          defaultPlacements: ["menubar-items"],
          defaultCollapsed: true,
        },
        true
      );
    }

    this.registerArea(
      CustomizableUI.AREA_TABSTRIP,
      {
        type: CustomizableUI.TYPE_TOOLBAR,
        defaultPlacements: [
          "firefox-view-button",
          "tabbrowser-tabs",
          "new-tab-button",
          "alltabs-button",
        ],
        defaultCollapsed: null,
      },
      true
    );
    this.registerArea(
      CustomizableUI.AREA_BOOKMARKS,
      {
        type: CustomizableUI.TYPE_TOOLBAR,
        defaultPlacements: ["personal-bookmarks"],
        defaultCollapsed: "newtab",
      },
      true
    );

    SearchWidgetTracker.init();

    Services.obs.addObserver(this, "browser-set-toolbar-visibility");
  },

  onEnabled(addon) {
    if (addon.type == "theme") {
      gSelectedTheme = addon;
    }
  },

  get _builtinAreas() {
    return new Set([
      ...this._builtinToolbars,
      CustomizableUI.AREA_FIXED_OVERFLOW_PANEL,
      CustomizableUI.AREA_ADDONS,
    ]);
  },

  get _builtinToolbars() {
    let toolbars = new Set([
      CustomizableUI.AREA_NAVBAR,
      CustomizableUI.AREA_BOOKMARKS,
      CustomizableUI.AREA_TABSTRIP,
    ]);
    if (AppConstants.platform != "macosx") {
      toolbars.add(CustomizableUI.AREA_MENUBAR);
    }
    return toolbars;
  },

  _defineBuiltInWidgets() {
    for (let widgetDefinition of lazy.CustomizableWidgets) {
      this.createBuiltinWidget(widgetDefinition);
    }
  },

  // eslint-disable-next-line complexity
  _updateForNewVersion() {
    // We should still enter even if gSavedState.currentVersion >= kVersion
    // because the per-widget pref facility is independent of versioning.
    if (!gSavedState) {
      // Flip all the prefs so we don't try to re-introduce later:
      for (let [, widget] of gPalette) {
        if (widget.defaultArea && widget._introducedInVersion === "pref") {
          let prefId = "browser.toolbarbuttons.introduced." + widget.id;
          Services.prefs.setBoolPref(prefId, true);
        }
      }
      return;
    }

    let currentVersion = gSavedState.currentVersion;
    for (let [id, widget] of gPalette) {
      if (widget.defaultArea) {
        let shouldAdd = false;
        let shouldSetPref = false;
        let prefId = "browser.toolbarbuttons.introduced." + widget.id;
        if (widget._introducedInVersion === "pref") {
          try {
            shouldAdd = !Services.prefs.getBoolPref(prefId);
          } catch (ex) {
            // Pref doesn't exist:
            shouldAdd = true;
          }
          shouldSetPref = shouldAdd;
        } else if (widget._introducedInVersion > currentVersion) {
          shouldAdd = true;
        } else if (
          widget._introducedByPref &&
          Services.prefs.getBoolPref(widget._introducedByPref)
        ) {
          shouldSetPref = shouldAdd = !Services.prefs.getBoolPref(
            prefId,
            false
          );
        }

        if (shouldAdd) {
          let futurePlacements = gFuturePlacements.get(widget.defaultArea);
          if (futurePlacements) {
            futurePlacements.add(id);
          } else {
            gFuturePlacements.set(widget.defaultArea, new Set([id]));
          }
          if (shouldSetPref) {
            Services.prefs.setBoolPref(prefId, true);
          }
        }
      }
    }

    // Nothing to migrate now if we don't have placements.
    if (!gSavedState.placements) {
      return;
    }

    if (
      currentVersion < 7 &&
      gSavedState.placements[CustomizableUI.AREA_NAVBAR]
    ) {
      let placements = gSavedState.placements[CustomizableUI.AREA_NAVBAR];
      let newPlacements = [
        "back-button",
        "forward-button",
        "stop-reload-button",
        "home-button",
      ];
      for (let button of placements) {
        if (!newPlacements.includes(button)) {
          newPlacements.push(button);
        }
      }

      if (!newPlacements.includes("sidebar-button")) {
        newPlacements.push("sidebar-button");
      }

      gSavedState.placements[CustomizableUI.AREA_NAVBAR] = newPlacements;
    }

    if (currentVersion < 8 && gSavedState.placements["PanelUI-contents"]) {
      let savedPanelPlacements = gSavedState.placements["PanelUI-contents"];
      delete gSavedState.placements["PanelUI-contents"];
      let defaultPlacements = [
        "edit-controls",
        "zoom-controls",
        "new-window-button",
        "privatebrowsing-button",
        "save-page-button",
        "print-button",
        "history-panelmenu",
        "fullscreen-button",
        "find-button",
        "preferences-button",
        // This widget no longer exists as of 2023, see Bug 1799009.
        "add-ons-button",
        "sync-button",
      ];

      if (!AppConstants.MOZ_DEV_EDITION) {
        defaultPlacements.splice(-1, 0, "developer-button");
      }

      let showCharacterEncoding = Services.prefs.getComplexValue(
        "browser.menu.showCharacterEncoding",
        Ci.nsIPrefLocalizedString
      ).data;
      if (showCharacterEncoding == "true") {
        defaultPlacements.push("characterencoding-button");
      }

      savedPanelPlacements = savedPanelPlacements.filter(
        id => !defaultPlacements.includes(id)
      );

      if (savedPanelPlacements.length) {
        gSavedState.placements[CustomizableUI.AREA_FIXED_OVERFLOW_PANEL] =
          savedPanelPlacements;
      }
    }

    if (currentVersion < 9 && gSavedState.placements["nav-bar"]) {
      let placements = gSavedState.placements["nav-bar"];
      if (placements.includes("urlbar-container")) {
        let urlbarIndex = placements.indexOf("urlbar-container");
        let secondSpringIndex = urlbarIndex + 1;
        // Insert if there isn't already a spring before the urlbar
        if (
          urlbarIndex == 0 ||
          !placements[urlbarIndex - 1].startsWith(kSpecialWidgetPfx + "spring")
        ) {
          placements.splice(urlbarIndex, 0, "spring");
          // The url bar is now 1 index later, so increment the insertion point for
          // the second spring.
          secondSpringIndex++;
        }
        // If the search container is present, insert after the search container
        // instead of after the url bar
        let searchContainerIndex = placements.indexOf("search-container");
        if (searchContainerIndex != -1) {
          secondSpringIndex = searchContainerIndex + 1;
        }
        if (
          secondSpringIndex == placements.length ||
          !placements[secondSpringIndex].startsWith(
            kSpecialWidgetPfx + "spring"
          )
        ) {
          placements.splice(secondSpringIndex, 0, "spring");
        }
      }

      // Finally, replace the bookmarks menu button with the library one if present
      if (placements.includes("bookmarks-menu-button")) {
        let bmbIndex = placements.indexOf("bookmarks-menu-button");
        placements.splice(bmbIndex, 1);
        let downloadButtonIndex = placements.indexOf("downloads-button");
        let libraryIndex =
          downloadButtonIndex == -1 ? bmbIndex : downloadButtonIndex + 1;
        placements.splice(libraryIndex, 0, "library-button");
      }
    }

    if (currentVersion < 10) {
      for (let placements of Object.values(gSavedState.placements)) {
        if (placements.includes("webcompat-reporter-button")) {
          placements.splice(placements.indexOf("webcompat-reporter-button"), 1);
          break;
        }
      }
    }

    // Move the downloads button to the default position in the navbar if it's
    // not there already.
    if (currentVersion < 11) {
      let navbarPlacements = gSavedState.placements[CustomizableUI.AREA_NAVBAR];
      // First remove from wherever it currently lives, if anywhere:
      for (let placements of Object.values(gSavedState.placements)) {
        let existingIndex = placements.indexOf("downloads-button");
        if (existingIndex != -1) {
          placements.splice(existingIndex, 1);
          break; // It can only be in 1 place, so no point looking elsewhere.
        }
      }

      // Now put the button in the navbar in the correct spot:
      if (navbarPlacements) {
        let insertionPoint = navbarPlacements.indexOf("urlbar-container");
        // Deliberately iterate to 1 past the end of the array to insert at the
        // end if need be.
        while (++insertionPoint < navbarPlacements.length) {
          let widget = navbarPlacements[insertionPoint];
          // If we find a non-searchbar, non-spacer node, break out of the loop:
          if (
            widget != "search-container" &&
            !this.matchingSpecials(widget, "spring")
          ) {
            break;
          }
        }
        // We either found the right spot, or reached the end of the
        // placements, so insert here:
        navbarPlacements.splice(insertionPoint, 0, "downloads-button");
      }
    }

    if (currentVersion < 12) {
      const removedButtons = [
        "loop-call-button",
        "loop-button-throttled",
        "pocket-button",
      ];
      for (let placements of Object.values(gSavedState.placements)) {
        for (let button of removedButtons) {
          let buttonIndex = placements.indexOf(button);
          if (buttonIndex != -1) {
            placements.splice(buttonIndex, 1);
          }
        }
      }
    }

    // Remove the old placements from the now-gone Nightly-only
    // "New non-e10s window" button.
    if (currentVersion < 13) {
      for (let placements of Object.values(gSavedState.placements)) {
        let buttonIndex = placements.indexOf("e10s-button");
        if (buttonIndex != -1) {
          placements.splice(buttonIndex, 1);
        }
      }
    }

    // Remove unsupported custom toolbar saved placements
    if (currentVersion < 14) {
      for (let area in gSavedState.placements) {
        if (!this._builtinAreas.has(area)) {
          delete gSavedState.placements[area];
        }
      }
    }

    // Add the FxA toolbar menu as the right most button item
    if (currentVersion < 16) {
      let navbarPlacements = gSavedState.placements[CustomizableUI.AREA_NAVBAR];
      // Place the menu item as the first item to the left of the hamburger menu
      if (navbarPlacements) {
        navbarPlacements.push("fxa-toolbar-menu-button");
      }
    }

    // Add the save to Pocket button left of downloads button.
    if (currentVersion < 17) {
      let navbarPlacements = gSavedState.placements[CustomizableUI.AREA_NAVBAR];
      let persistedPageActionsPref = Services.prefs.getCharPref(
        "browser.pageActions.persistedActions",
        ""
      );
      let pocketPreviouslyInUrl = true;
      try {
        let persistedPageActionsData = JSON.parse(persistedPageActionsPref);
        // If Pocket was previously not in the url bar, let's not put it in the toolbar.
        // It'll still be an option to add from the customization page.
        pocketPreviouslyInUrl =
          persistedPageActionsData.idsInUrlbar.includes("pocket");
      } catch (e) {}
      if (navbarPlacements && pocketPreviouslyInUrl) {
        // Pocket's new home is next to the downloads button, or the next best spot.
        let newPosition =
          navbarPlacements.indexOf("downloads-button") ??
          navbarPlacements.indexOf("fxa-toolbar-menu-button") ??
          navbarPlacements.length;

        navbarPlacements.splice(newPosition, 0, "save-to-pocket-button");
      }
    }

    // Add firefox-view if not present
    if (currentVersion < 18) {
      let tabstripPlacements =
        gSavedState.placements[CustomizableUI.AREA_TABSTRIP];
      if (
        tabstripPlacements &&
        !tabstripPlacements.includes("firefox-view-button")
      ) {
        tabstripPlacements.unshift("firefox-view-button");
      }
    }

    // Unified Extensions addon button migration, which puts any browser action
    // buttons in the overflow menu into the addons panel instead.
    if (currentVersion < 19) {
      let overflowPlacements =
        gSavedState.placements[CustomizableUI.AREA_FIXED_OVERFLOW_PANEL] || [];
      // The most likely case is that there are no AREA_ADDONS placements, in which case the
      // array won't exist.
      let addonsPlacements =
        gSavedState.placements[CustomizableUI.AREA_ADDONS] || [];

      // Migration algorithm for transitioning to Unified Extensions:
      //
      // 1. Create two arrays, one for extension widgets, one for built-in widgets.
      // 2. Iterate all items in the overflow panel, and push them into the
      //    appropriate array based on whether or not its an extension widget.
      // 3. Overwrite the overflow panel placements with the built-in widgets array.
      // 4. Prepend the extension widgets to the addonsPlacements array. Note that this
      //    does not overwrite this array as a precaution because it's possible
      //    (though pretty unlikely) that some widgets are already there.
      //
      // For extension widgets that were in the palette, they will be appended to the
      // addons area when they're created within createWidget.
      let extWidgets = [];
      let builtInWidgets = [];
      for (let widgetId of overflowPlacements) {
        if (CustomizableUI.isWebExtensionWidget(widgetId)) {
          extWidgets.push(widgetId);
        } else {
          builtInWidgets.push(widgetId);
        }
      }
      gSavedState.placements[CustomizableUI.AREA_FIXED_OVERFLOW_PANEL] =
        builtInWidgets;
      gSavedState.placements[CustomizableUI.AREA_ADDONS] = [
        ...extWidgets,
        ...addonsPlacements,
      ];
    }

    // Add the PBM reset button as the right most button item
    if (currentVersion < 20) {
      let navbarPlacements = gSavedState.placements[CustomizableUI.AREA_NAVBAR];
      // Place the button as the first item to the left of the hamburger menu
      if (
        navbarPlacements &&
        !navbarPlacements.includes("reset-pbm-toolbar-button")
      ) {
        navbarPlacements.push("reset-pbm-toolbar-button");
      }
    }
  },

  _updateForNewProtonVersion() {
    const VERSION = 3;
    let currentVersion = Services.prefs.getIntPref(
      kPrefProtonToolbarVersion,
      0
    );
    if (currentVersion >= VERSION) {
      return;
    }

    let placements = gSavedState?.placements?.[CustomizableUI.AREA_NAVBAR];

    if (!placements) {
      // The profile was created with this version, so no need to migrate.
      Services.prefs.setIntPref(kPrefProtonToolbarVersion, VERSION);
      return;
    }

    // Remove the home button if it hasn't been used and is set to about:home
    if (currentVersion < 1) {
      let homePage = lazy.HomePage.get();
      if (
        placements.includes("home-button") &&
        !Services.prefs.getBoolPref(kPrefHomeButtonUsed) &&
        (homePage == "about:home" || homePage == "about:blank") &&
        Services.policies.isAllowed("removeHomeButtonByDefault")
      ) {
        placements.splice(placements.indexOf("home-button"), 1);
      }
    }

    // Remove the library button if it hasn't been used
    if (currentVersion < 2) {
      if (
        placements.includes("library-button") &&
        !Services.prefs.getBoolPref(kPrefLibraryButtonUsed)
      ) {
        placements.splice(placements.indexOf("library-button"), 1);
      }
    }

    // Remove the library button if it hasn't been used
    if (currentVersion < 3) {
      if (
        placements.includes("sidebar-button") &&
        !Services.prefs.getBoolPref(kPrefSidebarButtonUsed)
      ) {
        placements.splice(placements.indexOf("sidebar-button"), 1);
      }
    }

    Services.prefs.setIntPref(kPrefProtonToolbarVersion, VERSION);
  },

  /**
   * _markObsoleteBuiltinButtonsSeen
   * when upgrading, ensure obsoleted buttons are in seen state.
   */
  _markObsoleteBuiltinButtonsSeen() {
    if (!gSavedState) {
      return;
    }
    let currentVersion = gSavedState.currentVersion;
    if (currentVersion >= kVersion) {
      return;
    }
    // we're upgrading, update state if necessary
    for (let id in ObsoleteBuiltinButtons) {
      let version = ObsoleteBuiltinButtons[id];
      if (version == kVersion) {
        gSeenWidgets.add(id);
        gDirty = true;
      }
    }
  },

  _placeNewDefaultWidgetsInArea(aArea) {
    let futurePlacedWidgets = gFuturePlacements.get(aArea);
    let savedPlacements =
      gSavedState && gSavedState.placements && gSavedState.placements[aArea];
    let defaultPlacements = gAreas.get(aArea).get("defaultPlacements");
    if (
      !savedPlacements ||
      !savedPlacements.length ||
      !futurePlacedWidgets ||
      !defaultPlacements ||
      !defaultPlacements.length
    ) {
      return;
    }
    let defaultWidgetIndex = -1;

    for (let widgetId of futurePlacedWidgets) {
      let widget = gPalette.get(widgetId);
      if (
        !widget ||
        widget.source !== CustomizableUI.SOURCE_BUILTIN ||
        !widget.defaultArea ||
        !(widget._introducedInVersion || widget._introducedByPref) ||
        savedPlacements.includes(widget.id)
      ) {
        continue;
      }
      defaultWidgetIndex = defaultPlacements.indexOf(widget.id);
      if (defaultWidgetIndex === -1) {
        continue;
      }
      // Now we know that this widget should be here by default, was newly introduced,
      // and we have a saved state to insert into, and a default state to work off of.
      // Try introducing after widgets that come before it in the default placements:
      for (let i = defaultWidgetIndex; i >= 0; i--) {
        // Special case: if the defaults list this widget as coming first, insert at the beginning:
        if (i === 0 && i === defaultWidgetIndex) {
          savedPlacements.splice(0, 0, widget.id);
          // Before you ask, yes, deleting things inside a let x of y loop where y is a Set is
          // safe, and we won't skip any items.
          futurePlacedWidgets.delete(widget.id);
          gDirty = true;
          break;
        }
        // Otherwise, if we're somewhere other than the beginning, check if the previous
        // widget is in the saved placements.
        if (i) {
          let previousWidget = defaultPlacements[i - 1];
          let previousWidgetIndex = savedPlacements.indexOf(previousWidget);
          if (previousWidgetIndex != -1) {
            savedPlacements.splice(previousWidgetIndex + 1, 0, widget.id);
            futurePlacedWidgets.delete(widget.id);
            gDirty = true;
            break;
          }
        }
      }
      // The loop above either inserts the item or doesn't - either way, we can get away
      // with doing nothing else now; if the item remains in gFuturePlacements, we'll
      // add it at the end in restoreStateForArea.
    }
    this.saveState();
  },

  getCustomizationTarget(aElement) {
    if (!aElement) {
      return null;
    }

    if (
      !aElement._customizationTarget &&
      aElement.hasAttribute("customizable")
    ) {
      let id = aElement.getAttribute("customizationtarget");
      if (id) {
        aElement._customizationTarget =
          aElement.ownerDocument.getElementById(id);
      }

      if (!aElement._customizationTarget) {
        aElement._customizationTarget = aElement;
      }
    }

    return aElement._customizationTarget;
  },

  wrapWidget(aWidgetId) {
    if (gGroupWrapperCache.has(aWidgetId)) {
      return gGroupWrapperCache.get(aWidgetId);
    }

    let provider = this.getWidgetProvider(aWidgetId);
    if (!provider) {
      return null;
    }

    if (provider == CustomizableUI.PROVIDER_API) {
      let widget = gPalette.get(aWidgetId);
      if (!widget.wrapper) {
        widget.wrapper = new WidgetGroupWrapper(widget);
        gGroupWrapperCache.set(aWidgetId, widget.wrapper);
      }
      return widget.wrapper;
    }

    // PROVIDER_SPECIAL gets treated the same as PROVIDER_XUL.
    // XXXgijs: this causes bugs in code that depends on widgetWrapper.provider
    // giving an accurate answer... filed as bug 1379821
    let wrapper = new XULWidgetGroupWrapper(aWidgetId);
    gGroupWrapperCache.set(aWidgetId, wrapper);
    return wrapper;
  },

  registerArea(aName, aProperties, aInternalCaller) {
    if (typeof aName != "string" || !/^[a-z0-9-_]{1,}$/i.test(aName)) {
      throw new Error("Invalid area name");
    }

    let areaIsKnown = gAreas.has(aName);
    let props = areaIsKnown ? gAreas.get(aName) : new Map();
    const kImmutableProperties = new Set(["type", "overflowable"]);
    for (let key in aProperties) {
      if (
        areaIsKnown &&
        kImmutableProperties.has(key) &&
        props.get(key) != aProperties[key]
      ) {
        throw new Error("An area cannot change the property for '" + key + "'");
      }
      props.set(key, aProperties[key]);
    }
    // Default to a toolbar:
    if (!props.has("type")) {
      props.set("type", CustomizableUI.TYPE_TOOLBAR);
    }
    if (props.get("type") == CustomizableUI.TYPE_TOOLBAR) {
      // Check aProperties instead of props because this check is only interested
      // in the passed arguments, not the state of a potentially pre-existing area.
      if (!aInternalCaller && aProperties.defaultCollapsed) {
        throw new Error(
          "defaultCollapsed is only allowed for default toolbars."
        );
      }
      if (!props.has("defaultCollapsed")) {
        props.set("defaultCollapsed", true);
      }
    } else if (props.has("defaultCollapsed")) {
      throw new Error("defaultCollapsed only applies for TYPE_TOOLBAR areas.");
    }
    // Sanity check type:
    let allTypes = [CustomizableUI.TYPE_TOOLBAR, CustomizableUI.TYPE_PANEL];
    if (!allTypes.includes(props.get("type"))) {
      throw new Error("Invalid area type " + props.get("type"));
    }

    // And to no placements:
    if (!props.has("defaultPlacements")) {
      props.set("defaultPlacements", []);
    }
    // Sanity check default placements array:
    if (!Array.isArray(props.get("defaultPlacements"))) {
      throw new Error("Should provide an array of default placements");
    }

    if (!areaIsKnown) {
      gAreas.set(aName, props);

      // Reconcile new default widgets. Have to do this before we start restoring things.
      this._placeNewDefaultWidgetsInArea(aName);

      if (
        props.get("type") == CustomizableUI.TYPE_TOOLBAR &&
        !gPlacements.has(aName)
      ) {
        // Guarantee this area exists in gFuturePlacements, to avoid checking it in
        // various places elsewhere.
        if (!gFuturePlacements.has(aName)) {
          gFuturePlacements.set(aName, new Set());
        }
      } else {
        this.restoreStateForArea(aName);
      }

      // If we have pending build area nodes, register all of them
      if (gPendingBuildAreas.has(aName)) {
        let pendingNodes = gPendingBuildAreas.get(aName);
        for (let pendingNode of pendingNodes) {
          this.registerToolbarNode(pendingNode);
        }
        gPendingBuildAreas.delete(aName);
      }
    }
  },

  unregisterArea(aName, aDestroyPlacements) {
    if (typeof aName != "string" || !/^[a-z0-9-_]{1,}$/i.test(aName)) {
      throw new Error("Invalid area name");
    }
    if (!gAreas.has(aName) && !gPlacements.has(aName)) {
      throw new Error("Area not registered");
    }

    // Move all the widgets out
    this.beginBatchUpdate();
    try {
      let placements = gPlacements.get(aName);
      if (placements) {
        // Need to clone this array so removeWidgetFromArea doesn't modify it
        placements = [...placements];
        placements.forEach(this.removeWidgetFromArea, this);
      }

      // Delete all remaining traces.
      gAreas.delete(aName);
      // Only destroy placements when necessary:
      if (aDestroyPlacements) {
        gPlacements.delete(aName);
      } else {
        // Otherwise we need to re-set them, as removeFromArea will have emptied
        // them out:
        gPlacements.set(aName, placements);
      }
      gFuturePlacements.delete(aName);
      let existingAreaNodes = gBuildAreas.get(aName);
      if (existingAreaNodes) {
        for (let areaNode of existingAreaNodes) {
          this.notifyListeners(
            "onAreaNodeUnregistered",
            aName,
            this.getCustomizationTarget(areaNode),
            CustomizableUI.REASON_AREA_UNREGISTERED
          );
        }
      }
      gBuildAreas.delete(aName);
    } finally {
      this.endBatchUpdate(true);
    }
  },

  registerToolbarNode(aToolbar) {
    let area = aToolbar.id;
    if (gBuildAreas.has(area) && gBuildAreas.get(area).has(aToolbar)) {
      return;
    }
    let areaProperties = gAreas.get(area);

    // If this area is not registered, try to do it automatically:
    if (!areaProperties) {
      if (!gPendingBuildAreas.has(area)) {
        gPendingBuildAreas.set(area, []);
      }
      gPendingBuildAreas.get(area).push(aToolbar);
      return;
    }

    this.beginBatchUpdate();
    try {
      let placements = gPlacements.get(area);
      if (
        !placements &&
        areaProperties.get("type") == CustomizableUI.TYPE_TOOLBAR
      ) {
        this.restoreStateForArea(area);
        placements = gPlacements.get(area);
      }

      // For toolbars that need it, mark as dirty.
      let defaultPlacements = areaProperties.get("defaultPlacements");
      if (
        !this._builtinToolbars.has(area) ||
        placements.length != defaultPlacements.length ||
        !placements.every((id, i) => id == defaultPlacements[i])
      ) {
        gDirtyAreaCache.add(area);
      }

      if (areaProperties.get("overflowable")) {
        aToolbar.overflowable = new OverflowableToolbar(aToolbar);
      }

      this.registerBuildArea(area, aToolbar);

      // We only build the toolbar if it's been marked as "dirty". Dirty means
      // one of the following things:
      // 1) Items have been added, moved or removed from this toolbar before.
      // 2) The number of children of the toolbar does not match the length of
      //    the placements array for that area.
      //
      // This notion of being "dirty" is stored in a cache which is persisted
      // in the saved state.
      //
      // Secondly, if the list of placements contains an API-provided widget,
      // we need to call `buildArea` or it won't be built and put in the toolbar.
      if (
        gDirtyAreaCache.has(area) ||
        placements.some(id => gPalette.has(id))
      ) {
        this.buildArea(area, placements, aToolbar);
      } else {
        // We must have a builtin toolbar that's in the default state. We need
        // to only make sure that all the special nodes are correct.
        let specials = placements.filter(p => this.isSpecialWidget(p));
        if (specials.length) {
          this.updateSpecialsForBuiltinToolbar(aToolbar, specials);
        }
      }
      this.notifyListeners(
        "onAreaNodeRegistered",
        area,
        this.getCustomizationTarget(aToolbar)
      );
    } finally {
      this.endBatchUpdate();
    }
  },

  updateSpecialsForBuiltinToolbar(aToolbar, aSpecialIDs) {
    // Nodes are going to be in the correct order, so we can do this straightforwardly:
    let { children } = this.getCustomizationTarget(aToolbar);
    for (let kid of children) {
      if (
        this.matchingSpecials(aSpecialIDs[0], kid) &&
        kid.getAttribute("skipintoolbarset") != "true"
      ) {
        kid.id = aSpecialIDs.shift();
      }
      if (!aSpecialIDs.length) {
        return;
      }
    }
  },

  buildArea(aArea, aPlacements, aAreaNode) {
    let document = aAreaNode.ownerDocument;
    let window = document.defaultView;
    let inPrivateWindow = lazy.PrivateBrowsingUtils.isWindowPrivate(window);
    let container = this.getCustomizationTarget(aAreaNode);
    let areaIsPanel =
      gAreas.get(aArea).get("type") == CustomizableUI.TYPE_PANEL;

    if (!container) {
      throw new Error(
        "Expected area " + aArea + " to have a customizationTarget attribute."
      );
    }

    // Restore nav-bar visibility since it may have been hidden
    // through a migration path (bug 938980) or an add-on.
    if (aArea == CustomizableUI.AREA_NAVBAR) {
      aAreaNode.collapsed = false;
    }

    this.beginBatchUpdate();

    try {
      let currentNode = container.firstElementChild;
      let placementsToRemove = new Set();
      for (let id of aPlacements) {
        while (
          currentNode &&
          currentNode.getAttribute("skipintoolbarset") == "true"
        ) {
          currentNode = currentNode.nextElementSibling;
        }

        // Fix ids for specials and continue, for correctly placed specials.
        if (
          currentNode &&
          (!currentNode.id || CustomizableUI.isSpecialWidget(currentNode)) &&
          this.matchingSpecials(id, currentNode)
        ) {
          currentNode.id = id;
        }
        if (currentNode && currentNode.id == id) {
          currentNode = currentNode.nextElementSibling;
          continue;
        }

        if (this.isSpecialWidget(id) && areaIsPanel) {
          placementsToRemove.add(id);
          continue;
        }

        let [provider, node] = this.getWidgetNode(id, window);
        if (!node) {
          lazy.log.debug("Unknown widget: " + id);
          continue;
        }

        let widget = null;
        // If the placements have items in them which are (now) no longer removable,
        // we shouldn't be moving them:
        if (provider == CustomizableUI.PROVIDER_API) {
          widget = gPalette.get(id);
          if (!widget.removable && aArea != widget.defaultArea) {
            placementsToRemove.add(id);
            continue;
          }
        } else if (
          provider == CustomizableUI.PROVIDER_XUL &&
          node.parentNode != container &&
          !this.isWidgetRemovable(node)
        ) {
          placementsToRemove.add(id);
          continue;
        } // Special widgets are always removable, so no need to check them

        if (inPrivateWindow && widget && !widget.showInPrivateBrowsing) {
          continue;
        }

        this.ensureButtonContextMenu(node, aAreaNode);

        // This needs updating in case we're resetting / undoing a reset.
        if (widget) {
          widget.currentArea = aArea;
        }
        this.insertWidgetBefore(node, currentNode, container, aArea);
        if (gResetting) {
          this.notifyListeners("onWidgetReset", node, container);
        } else if (gUndoResetting) {
          this.notifyListeners("onWidgetUndoMove", node, container);
        }
      }

      if (currentNode) {
        let palette = window.gNavToolbox ? window.gNavToolbox.palette : null;
        let limit = currentNode.previousElementSibling;
        let node = container.lastElementChild;
        while (node && node != limit) {
          let previousSibling = node.previousElementSibling;
          // Nodes opt-in to removability. If they're removable, and we haven't
          // seen them in the placements array, then we toss them into the palette
          // if one exists. If no palette exists, we just remove the node. If the
          // node is not removable, we leave it where it is. However, we can only
          // safely touch elements that have an ID - both because we depend on
          // IDs (or are specials), and because such elements are not intended to
          // be widgets (eg, titlebar-spacer elements).
          if (
            (node.id || this.isSpecialWidget(node)) &&
            node.getAttribute("skipintoolbarset") != "true"
          ) {
            if (this.isWidgetRemovable(node)) {
              if (node.id && (gResetting || gUndoResetting)) {
                let widget = gPalette.get(node.id);
                if (widget) {
                  widget.currentArea = null;
                }
              }
              this.notifyDOMChange(node, null, container, true, () => {
                if (palette && !this.isSpecialWidget(node.id)) {
                  palette.appendChild(node);
                  this.removeLocationAttributes(node);
                } else {
                  container.removeChild(node);
                }
              });
            } else {
              node.setAttribute("removable", false);
              lazy.log.debug(
                "Adding non-removable widget to placements of " +
                  aArea +
                  ": " +
                  node.id
              );
              gPlacements.get(aArea).push(node.id);
              gDirty = true;
            }
          }
          node = previousSibling;
        }
      }

      // If there are placements in here which aren't removable from their original area,
      // we remove them from this area's placement array. They will (have) be(en) added
      // to their original area's placements array in the block above this one.
      if (placementsToRemove.size) {
        let placementAry = gPlacements.get(aArea);
        for (let id of placementsToRemove) {
          let index = placementAry.indexOf(id);
          placementAry.splice(index, 1);
        }
      }

      if (gResetting) {
        this.notifyListeners("onAreaReset", aArea, container);
      }
    } finally {
      this.endBatchUpdate();
    }
  },

  addPanelCloseListeners(aPanel) {
    aPanel.addEventListener("click", this, { mozSystemGroup: true });
    aPanel.addEventListener("keypress", this, { mozSystemGroup: true });
    let win = aPanel.ownerGlobal;
    if (!gPanelsForWindow.has(win)) {
      gPanelsForWindow.set(win, new Set());
    }
    gPanelsForWindow.get(win).add(this._getPanelForNode(aPanel));
  },

  removePanelCloseListeners(aPanel) {
    aPanel.removeEventListener("click", this, { mozSystemGroup: true });
    aPanel.removeEventListener("keypress", this, { mozSystemGroup: true });
    let win = aPanel.ownerGlobal;
    let panels = gPanelsForWindow.get(win);
    if (panels) {
      panels.delete(this._getPanelForNode(aPanel));
    }
  },

  ensureButtonContextMenu(aNode, aAreaNode, forcePanel) {
    const kPanelItemContextMenu = "customizationPanelItemContextMenu";

    let currentContextMenu =
      aNode.getAttribute("context") || aNode.getAttribute("contextmenu");
    let contextMenuForPlace;

    if (
      CustomizableUI.isWebExtensionWidget(aNode.id) &&
      (aAreaNode?.id == CustomizableUI.AREA_ADDONS ||
        aNode.getAttribute("overflowedItem") == "true")
    ) {
      contextMenuForPlace = null;
    } else {
      contextMenuForPlace =
        forcePanel || "panel" == CustomizableUI.getPlaceForItem(aAreaNode)
          ? kPanelItemContextMenu
          : null;
    }
    if (contextMenuForPlace && !currentContextMenu) {
      aNode.setAttribute("context", contextMenuForPlace);
    } else if (
      currentContextMenu == kPanelItemContextMenu &&
      contextMenuForPlace != kPanelItemContextMenu
    ) {
      aNode.removeAttribute("context");
      aNode.removeAttribute("contextmenu");
    }
  },

  getWidgetProvider(aWidgetId) {
    if (this.isSpecialWidget(aWidgetId)) {
      return CustomizableUI.PROVIDER_SPECIAL;
    }
    if (gPalette.has(aWidgetId)) {
      return CustomizableUI.PROVIDER_API;
    }
    // If this was an API widget that was destroyed, return null:
    if (gSeenWidgets.has(aWidgetId)) {
      return null;
    }

    // We fall back to the XUL provider, but we don't know for sure (at this
    // point) whether it exists there either. So the API is technically lying.
    // Ideally, it would be able to return an error value (or throw an
    // exception) if it really didn't exist. Our code calling this function
    // handles that fine, but this is a public API.
    return CustomizableUI.PROVIDER_XUL;
  },

  getWidgetNode(aWidgetId, aWindow) {
    let document = aWindow.document;

    if (this.isSpecialWidget(aWidgetId)) {
      let widgetNode =
        document.getElementById(aWidgetId) ||
        this.createSpecialWidget(aWidgetId, document);
      return [CustomizableUI.PROVIDER_SPECIAL, widgetNode];
    }

    let widget = gPalette.get(aWidgetId);
    if (widget) {
      // If we have an instance of this widget already, just use that.
      if (widget.instances.has(document)) {
        lazy.log.debug(
          "An instance of widget " +
            aWidgetId +
            " already exists in this " +
            "document. Reusing."
        );
        return [CustomizableUI.PROVIDER_API, widget.instances.get(document)];
      }

      return [CustomizableUI.PROVIDER_API, this.buildWidget(document, widget)];
    }

    lazy.log.debug("Searching for " + aWidgetId + " in toolbox.");
    let node = this.findWidgetInWindow(aWidgetId, aWindow);
    if (node) {
      return [CustomizableUI.PROVIDER_XUL, node];
    }

    lazy.log.debug("No node for " + aWidgetId + " found.");
    return [null, null];
  },

  registerPanelNode(aNode, aArea) {
    if (gBuildAreas.has(aArea) && gBuildAreas.get(aArea).has(aNode)) {
      return;
    }

    aNode._customizationTarget = aNode;
    this.addPanelCloseListeners(this._getPanelForNode(aNode));

    let placements = gPlacements.get(aArea);
    this.buildArea(aArea, placements, aNode);
    this.notifyListeners("onAreaNodeRegistered", aArea, aNode);

    for (let child of aNode.children) {
      if (child.localName != "toolbarbutton") {
        if (child.localName == "toolbaritem") {
          this.ensureButtonContextMenu(child, aNode, true);
        }
        continue;
      }
      this.ensureButtonContextMenu(child, aNode, true);
    }

    this.registerBuildArea(aArea, aNode);
  },

  onWidgetAdded(aWidgetId, aArea, aPosition) {
    this.insertNode(aWidgetId, aArea, aPosition, true);

    if (!gResetting) {
      this._clearPreviousUIState();
    }
  },

  onWidgetRemoved(aWidgetId, aArea) {
    let areaNodes = gBuildAreas.get(aArea);
    if (!areaNodes) {
      return;
    }

    let area = gAreas.get(aArea);
    let isToolbar = area.get("type") == CustomizableUI.TYPE_TOOLBAR;
    let isOverflowable = isToolbar && area.get("overflowable");
    let showInPrivateBrowsing = gPalette.has(aWidgetId)
      ? gPalette.get(aWidgetId).showInPrivateBrowsing
      : true;

    for (let areaNode of areaNodes) {
      let window = areaNode.ownerGlobal;
      if (
        !showInPrivateBrowsing &&
        lazy.PrivateBrowsingUtils.isWindowPrivate(window)
      ) {
        continue;
      }

      let container = this.getCustomizationTarget(areaNode);
      let widgetNode = window.document.getElementById(aWidgetId);
      if (widgetNode && isOverflowable) {
        container = areaNode.overflowable.getContainerFor(widgetNode);
      }

      if (!widgetNode || !container.contains(widgetNode)) {
        lazy.log.info(
          "Widget " + aWidgetId + " not found, unable to remove from " + aArea
        );
        continue;
      }

      this.notifyDOMChange(widgetNode, null, container, true, () => {
        // We remove location attributes here to make sure they're gone too when a
        // widget is removed from a toolbar to the palette. See bug 930950.
        this.removeLocationAttributes(widgetNode);
        // We also need to remove the panel context menu if it's there:
        this.ensureButtonContextMenu(widgetNode);
        if (gPalette.has(aWidgetId) || this.isSpecialWidget(aWidgetId)) {
          container.removeChild(widgetNode);
        } else {
          window.gNavToolbox.palette.appendChild(widgetNode);
        }
      });

      let windowCache = gSingleWrapperCache.get(window);
      if (windowCache) {
        windowCache.delete(aWidgetId);
      }
    }
    if (!gResetting) {
      this._clearPreviousUIState();
    }
  },

  onWidgetMoved(aWidgetId, aArea, aOldPosition, aNewPosition) {
    this.insertNode(aWidgetId, aArea, aNewPosition);
    if (!gResetting) {
      this._clearPreviousUIState();
    }
  },

  onCustomizeEnd() {
    this._clearPreviousUIState();
  },

  registerBuildArea(aArea, aNode) {
    // We ensure that the window is registered to have its customization data
    // cleaned up when unloading.
    let window = aNode.ownerGlobal;
    if (window.closed) {
      return;
    }
    this.registerBuildWindow(window);

    // Also register this build area's toolbox.
    if (window.gNavToolbox) {
      gBuildWindows.get(window).add(window.gNavToolbox);
    }

    if (!gBuildAreas.has(aArea)) {
      gBuildAreas.set(aArea, new Set());
    }

    gBuildAreas.get(aArea).add(aNode);

    // Give a class to all customize targets to be used for styling in Customize Mode
    let customizableNode = this.getCustomizeTargetForArea(aArea, window);
    customizableNode.classList.add("customization-target");
  },

  registerBuildWindow(aWindow) {
    if (!gBuildWindows.has(aWindow)) {
      gBuildWindows.set(aWindow, new Set());

      aWindow.addEventListener("unload", this);
      aWindow.addEventListener("command", this, true);

      this.notifyListeners("onWindowOpened", aWindow);
    }
  },

  unregisterBuildWindow(aWindow) {
    aWindow.removeEventListener("unload", this);
    aWindow.removeEventListener("command", this, true);
    gPanelsForWindow.delete(aWindow);
    gBuildWindows.delete(aWindow);
    gSingleWrapperCache.delete(aWindow);
    let document = aWindow.document;

    for (let [areaId, areaNodes] of gBuildAreas) {
      let areaProperties = gAreas.get(areaId);
      for (let node of areaNodes) {
        if (node.ownerDocument == document) {
          this.notifyListeners(
            "onAreaNodeUnregistered",
            areaId,
            this.getCustomizationTarget(node),
            CustomizableUI.REASON_WINDOW_CLOSED
          );
          if (areaProperties.get("overflowable")) {
            node.overflowable.uninit();
            node.overflowable = null;
          }
          areaNodes.delete(node);
        }
      }
    }

    for (let [, widget] of gPalette) {
      widget.instances.delete(document);
      this.notifyListeners("onWidgetInstanceRemoved", widget.id, document);
    }

    for (let [, pendingNodes] of gPendingBuildAreas) {
      for (let i = pendingNodes.length - 1; i >= 0; i--) {
        if (pendingNodes[i].ownerDocument == document) {
          pendingNodes.splice(i, 1);
        }
      }
    }

    this.notifyListeners("onWindowClosed", aWindow);
  },

  setLocationAttributes(aNode, aArea) {
    let props = gAreas.get(aArea);
    if (!props) {
      throw new Error(
        "Expected area " +
          aArea +
          " to have a properties Map " +
          "associated with it."
      );
    }

    aNode.setAttribute("cui-areatype", props.get("type") || "");
    let anchor = props.get("anchor");
    if (anchor) {
      aNode.setAttribute("cui-anchorid", anchor);
    } else {
      aNode.removeAttribute("cui-anchorid");
    }
  },

  removeLocationAttributes(aNode) {
    aNode.removeAttribute("cui-areatype");
    aNode.removeAttribute("cui-anchorid");
  },

  insertNode(aWidgetId, aArea, aPosition, isNew) {
    let areaNodes = gBuildAreas.get(aArea);
    if (!areaNodes) {
      return;
    }

    let placements = gPlacements.get(aArea);
    if (!placements) {
      lazy.log.error(
        "Could not find any placements for " + aArea + " when moving a widget."
      );
      return;
    }

    // Go through each of the nodes associated with this area and move the
    // widget to the requested location.
    for (let areaNode of areaNodes) {
      this.insertNodeInWindow(aWidgetId, areaNode, isNew);
    }
  },

  insertNodeInWindow(aWidgetId, aAreaNode, isNew) {
    let window = aAreaNode.ownerGlobal;
    let showInPrivateBrowsing = gPalette.has(aWidgetId)
      ? gPalette.get(aWidgetId).showInPrivateBrowsing
      : true;

    if (
      !showInPrivateBrowsing &&
      lazy.PrivateBrowsingUtils.isWindowPrivate(window)
    ) {
      return;
    }

    let [, widgetNode] = this.getWidgetNode(aWidgetId, window);
    if (!widgetNode) {
      lazy.log.error("Widget '" + aWidgetId + "' not found, unable to move");
      return;
    }

    let areaId = aAreaNode.id;
    if (isNew) {
      this.ensureButtonContextMenu(widgetNode, aAreaNode);
    }

    let [insertionContainer, nextNode] = this.findInsertionPoints(
      widgetNode,
      aAreaNode
    );
    this.insertWidgetBefore(widgetNode, nextNode, insertionContainer, areaId);
  },

  findInsertionPoints(aNode, aAreaNode) {
    let areaId = aAreaNode.id;
    let props = gAreas.get(areaId);

    // For overflowable toolbars, rely on them (because the work is more complicated):
    if (
      props.get("type") == CustomizableUI.TYPE_TOOLBAR &&
      props.get("overflowable")
    ) {
      return aAreaNode.overflowable.findOverflowedInsertionPoints(aNode);
    }

    let container = this.getCustomizationTarget(aAreaNode);
    let placements = gPlacements.get(areaId);
    let nodeIndex = placements.indexOf(aNode.id);

    while (++nodeIndex < placements.length) {
      let nextNodeId = placements[nodeIndex];
      // We use aAreaNode here, because if aNode is in a template, its
      // `ownerDocument` is *not* going to be the browser.xhtml document,
      // so we cannot rely on it.
      let nextNode = aAreaNode.ownerDocument.getElementById(nextNodeId);
      // If the next placed widget exists, and is a direct child of the
      // container, or wrapped in a customize mode wrapper (toolbarpaletteitem)
      // inside the container, insert beside it.
      // We have to check the parent to avoid errors when the placement ids
      // are for nodes that are no longer customizable.
      if (
        nextNode &&
        (nextNode.parentNode == container ||
          (nextNode.parentNode.localName == "toolbarpaletteitem" &&
            nextNode.parentNode.parentNode == container))
      ) {
        return [container, nextNode];
      }
    }

    return [container, null];
  },

  insertWidgetBefore(aNode, aNextNode, aContainer, aArea) {
    this.notifyDOMChange(aNode, aNextNode, aContainer, false, () => {
      this.setLocationAttributes(aNode, aArea);
      aContainer.insertBefore(aNode, aNextNode);
    });
  },

  notifyDOMChange(aNode, aNextNode, aContainer, aIsRemove, aCallback) {
    this.notifyListeners(
      "onWidgetBeforeDOMChange",
      aNode,
      aNextNode,
      aContainer,
      aIsRemove
    );
    aCallback();
    this.notifyListeners(
      "onWidgetAfterDOMChange",
      aNode,
      aNextNode,
      aContainer,
      aIsRemove
    );
  },

  handleEvent(aEvent) {
    switch (aEvent.type) {
      case "command":
        if (!this._originalEventInPanel(aEvent)) {
          break;
        }
        aEvent = aEvent.sourceEvent;
      // Fall through
      case "click":
      case "keypress":
        this.maybeAutoHidePanel(aEvent);
        break;
      case "unload":
        this.unregisterBuildWindow(aEvent.currentTarget);
        break;
    }
  },

  _originalEventInPanel(aEvent) {
    let e = aEvent.sourceEvent;
    if (!e) {
      return false;
    }
    let node = this._getPanelForNode(e.target);
    if (!node) {
      return false;
    }
    let win = e.view;
    let panels = gPanelsForWindow.get(win);
    return !!panels && panels.has(node);
  },

  _getSpecialIdForNode(aNode) {
    if (typeof aNode == "object" && aNode.localName) {
      if (aNode.id) {
        return aNode.id;
      }
      if (aNode.localName.startsWith("toolbar")) {
        return aNode.localName.substring(7);
      }
      return "";
    }
    return aNode;
  },

  isSpecialWidget(aId) {
    aId = this._getSpecialIdForNode(aId);
    return (
      aId.startsWith(kSpecialWidgetPfx) ||
      aId.startsWith("separator") ||
      aId.startsWith("spring") ||
      aId.startsWith("spacer")
    );
  },

  matchingSpecials(aId1, aId2) {
    aId1 = this._getSpecialIdForNode(aId1);
    aId2 = this._getSpecialIdForNode(aId2);

    return (
      this.isSpecialWidget(aId1) &&
      this.isSpecialWidget(aId2) &&
      aId1.match(/spring|spacer|separator/)[0] ==
        aId2.match(/spring|spacer|separator/)[0]
    );
  },

  ensureSpecialWidgetId(aId) {
    let nodeType = aId.match(/spring|spacer|separator/)[0];
    // If the ID we were passed isn't a generated one, generate one now:
    if (nodeType == aId) {
      // Ids are differentiated through a unique count suffix.
      return kSpecialWidgetPfx + aId + ++gNewElementCount;
    }
    return aId;
  },

  createSpecialWidget(aId, aDocument) {
    let nodeName = "toolbar" + aId.match(/spring|spacer|separator/)[0];
    let node = aDocument.createXULElement(nodeName);
    node.className = "chromeclass-toolbar-additional";
    node.id = this.ensureSpecialWidgetId(aId);
    return node;
  },

  /* Find a XUL-provided widget in a window. Don't try to use this
   * for an API-provided widget or a special widget.
   */
  findWidgetInWindow(aId, aWindow) {
    if (!gBuildWindows.has(aWindow)) {
      throw new Error("Build window not registered");
    }

    if (!aId) {
      lazy.log.error("findWidgetInWindow was passed an empty string.");
      return null;
    }

    let document = aWindow.document;

    // look for a node with the same id, as the node may be
    // in a different toolbar.
    let node = document.getElementById(aId);
    if (node) {
      let parent = node.parentNode;
      while (
        parent &&
        !(
          this.getCustomizationTarget(parent) ||
          parent == aWindow.gNavToolbox.palette
        )
      ) {
        parent = parent.parentNode;
      }

      if (parent) {
        let nodeInArea =
          node.parentNode.localName == "toolbarpaletteitem"
            ? node.parentNode
            : node;
        // Check if we're in a customization target, or in the palette:
        if (
          (this.getCustomizationTarget(parent) == nodeInArea.parentNode &&
            gBuildWindows.get(aWindow).has(aWindow.gNavToolbox)) ||
          aWindow.gNavToolbox.palette == nodeInArea.parentNode
        ) {
          // Normalize the removable attribute. For backwards compat, if
          // the widget is not located in a toolbox palette then absence
          // of the "removable" attribute means it is not removable.
          if (!node.hasAttribute("removable")) {
            // If we first see this in customization mode, it may be in the
            // customization palette instead of the toolbox palette.
            node.setAttribute(
              "removable",
              !this.getCustomizationTarget(parent)
            );
          }
          return node;
        }
      }
    }

    let toolboxes = gBuildWindows.get(aWindow);
    for (let toolbox of toolboxes) {
      if (toolbox.palette) {
        // Attempt to locate an element with a matching ID within
        // the palette.
        let element = toolbox.palette.getElementsByAttribute("id", aId)[0];
        if (element) {
          // Normalize the removable attribute. For backwards compat, this
          // is optional if the widget is located in the toolbox palette,
          // and defaults to *true*, unlike if it was located elsewhere.
          if (!element.hasAttribute("removable")) {
            element.setAttribute("removable", true);
          }
          return element;
        }
      }
    }
    return null;
  },

  buildWidget(aDocument, aWidget) {
    if (aDocument.documentURI != kExpectedWindowURL) {
      throw new Error("buildWidget was called for a non-browser window!");
    }
    if (typeof aWidget == "string") {
      aWidget = gPalette.get(aWidget);
    }
    if (!aWidget) {
      throw new Error("buildWidget was passed a non-widget to build.");
    }
    if (
      !aWidget.showInPrivateBrowsing &&
      lazy.PrivateBrowsingUtils.isWindowPrivate(aDocument.defaultView)
    ) {
      return null;
    }

    lazy.log.debug("Building " + aWidget.id + " of type " + aWidget.type);

    let node;
    let button;
    if (aWidget.type == "custom") {
      if (aWidget.onBuild) {
        node = aWidget.onBuild(aDocument);
      }
      if (
        !node ||
        !aDocument.defaultView.XULElement.isInstance(node) ||
        (aWidget.viewId && !node.viewButton)
      ) {
        lazy.log.error(
          "Custom widget with id " +
            aWidget.id +
            " does not return a valid node"
        );
      }
      // A custom widget can define a viewId for the panel and a viewButton
      // property for the panel anchor.  With that, it will be treated as a view
      // type where necessary to hook up the view panel.
      if (aWidget.viewId) {
        button = node.viewButton;
      }
    }
    // Button and view widget types, plus custom widgets that have a viewId and thus a button.
    if (button || aWidget.type != "custom") {
      if (
        aWidget.onBeforeCreated &&
        aWidget.onBeforeCreated(aDocument) === false
      ) {
        return null;
      }

      if (!button) {
        button = aDocument.createXULElement("toolbarbutton");
        node = button;
      }
      button.classList.add("toolbarbutton-1");
      button.setAttribute("delegatesanchor", "true");

      let viewbutton = null;
      if (aWidget.type == "button-and-view") {
        button.setAttribute("id", aWidget.id + "-button");
        let dropmarker = aDocument.createXULElement("toolbarbutton");
        dropmarker.setAttribute("id", aWidget.id + "-dropmarker");
        dropmarker.setAttribute("delegatesanchor", "true");
        dropmarker.classList.add(
          "toolbarbutton-1",
          "toolbarbutton-combined-buttons-dropmarker"
        );
        node = aDocument.createXULElement("toolbaritem");
        node.classList.add("toolbaritem-combined-buttons");
        node.append(button, dropmarker);
        viewbutton = dropmarker;
      } else if (aWidget.viewId) {
        // Also set viewbutton for anything with a view
        viewbutton = button;
      }

      node.setAttribute("id", aWidget.id);
      node.setAttribute("widget-id", aWidget.id);
      node.setAttribute("widget-type", aWidget.type);
      if (aWidget.disabled) {
        node.setAttribute("disabled", true);
      }
      node.setAttribute("removable", aWidget.removable);
      node.setAttribute("overflows", aWidget.overflows);
      if (aWidget.tabSpecific) {
        node.setAttribute("tabspecific", aWidget.tabSpecific);
      }
      if (aWidget.locationSpecific) {
        node.setAttribute("locationspecific", aWidget.locationSpecific);
      }
      if (aWidget.keepBroadcastAttributesWhenCustomizing) {
        node.setAttribute(
          "keepbroadcastattributeswhencustomizing",
          aWidget.keepBroadcastAttributesWhenCustomizing
        );
      }

      let shortcut;
      if (aWidget.shortcutId) {
        let keyEl = aDocument.getElementById(aWidget.shortcutId);
        if (keyEl) {
          shortcut = lazy.ShortcutUtils.prettifyShortcut(keyEl);
        } else {
          lazy.log.error(
            "Key element with id '" +
              aWidget.shortcutId +
              "' for widget '" +
              aWidget.id +
              "' not found!"
          );
        }
      }

      if (aWidget.l10nId) {
        aDocument.l10n.setAttributes(node, aWidget.l10nId);
        if (button != node) {
          // This is probably a "button-and-view" widget, such as the Profiler
          // button. In that case, "node" is the "toolbaritem" container, and
          // "button" the main button (see above).
          // In this case, the values on the "node" is used in the Customize
          // view, as well as the tooltips over both buttons; the values on the
          // "button" are used in the overflow menu.
          aDocument.l10n.setAttributes(button, aWidget.l10nId);
        }

        if (shortcut) {
          node.setAttribute("data-l10n-args", JSON.stringify({ shortcut }));
          if (button != node) {
            // This is probably a "button-and-view" widget.
            button.setAttribute("data-l10n-args", JSON.stringify({ shortcut }));
          }
        }
      } else {
        node.setAttribute("label", this.getLocalizedProperty(aWidget, "label"));
        if (button != node) {
          // This is probably a "button-and-view" widget.
          button.setAttribute("label", node.getAttribute("label"));
        }

        let tooltip = this.getLocalizedProperty(
          aWidget,
          "tooltiptext",
          shortcut ? [shortcut] : []
        );
        if (tooltip) {
          node.setAttribute("tooltiptext", tooltip);
          if (button != node) {
            // This is probably a "button-and-view" widget.
            button.setAttribute("tooltiptext", tooltip);
          }
        }
      }

      let commandHandler = this.handleWidgetCommand.bind(this, aWidget, node);
      node.addEventListener("command", commandHandler);
      let clickHandler = this.handleWidgetClick.bind(this, aWidget, node);
      node.addEventListener("click", clickHandler);

      node.classList.add("chromeclass-toolbar-additional");

      // If the widget has a view, register a keypress handler because opening
      // a view with the keyboard has slightly different focus handling than
      // opening a view with the mouse. (When opened with the keyboard, the
      // first item in the view should be focused after opening.)
      if (viewbutton) {
        lazy.log.debug(
          "Widget " +
            aWidget.id +
            " has a view. Auto-registering event handlers."
        );

        if (aWidget.source == CustomizableUI.SOURCE_BUILTIN) {
          node.classList.add("subviewbutton-nav");
        }
      }

      if (aWidget.onCreated) {
        aWidget.onCreated(node);
      }
    }

    aWidget.instances.set(aDocument, node);
    return node;
  },

  ensureSubviewListeners(viewNode) {
    if (viewNode._addedEventListeners) {
      return;
    }
    let viewId = viewNode.id;
    let widget = [...gPalette.values()].find(w => w.viewId == viewId);
    if (!widget) {
      return;
    }
    for (let eventName of kSubviewEvents) {
      let handler = "on" + eventName;
      if (typeof widget[handler] == "function") {
        viewNode.addEventListener(eventName, widget[handler]);
      }
    }
    viewNode._addedEventListeners = true;
    lazy.log.debug(
      "Widget " + widget.id + " showing and hiding event handlers set."
    );
  },

  getLocalizedProperty(aWidget, aProp, aFormatArgs, aDef) {
    const kReqStringProps = ["label"];

    if (typeof aWidget == "string") {
      aWidget = gPalette.get(aWidget);
    }
    if (!aWidget) {
      throw new Error(
        "getLocalizedProperty was passed a non-widget to work with."
      );
    }
    let def, name;
    // Let widgets pass their own string identifiers or strings, so that
    // we can use strings which aren't the default (in case string ids change)
    // and so that non-builtin-widgets can also provide labels, tooltips, etc.
    if (aWidget[aProp] != null) {
      name = aWidget[aProp];
      // By using this as the default, if a widget provides a full string rather
      // than a string ID for localization, we will fall back to that string
      // and return that.
      def = aDef || name;
    } else {
      name = aWidget.id + "." + aProp;
      def = aDef || "";
    }
    if (aWidget.localized === false) {
      return def;
    }
    try {
      if (Array.isArray(aFormatArgs) && aFormatArgs.length) {
        return (
          lazy.gWidgetsBundle.formatStringFromName(name, aFormatArgs) || def
        );
      }
      return lazy.gWidgetsBundle.GetStringFromName(name) || def;
    } catch (ex) {
      // If an empty string was explicitly passed, treat it as an actual
      // value rather than a missing property.
      if (!def && (name != "" || kReqStringProps.includes(aProp))) {
        lazy.log.error("Could not localize property '" + name + "'.");
      }
    }
    return def;
  },

  addShortcut(aShortcutNode, aTargetNode = aShortcutNode) {
    // Detect if we've already been here before.
    if (aTargetNode.hasAttribute("shortcut")) {
      return;
    }

    // Use ownerGlobal.document to ensure we get the right doc even for
    // elements in template tags.
    let { document } = aShortcutNode.ownerGlobal;
    let shortcutId = aShortcutNode.getAttribute("key");
    let shortcut;
    if (shortcutId) {
      shortcut = document.getElementById(shortcutId);
    } else {
      let commandId = aShortcutNode.getAttribute("command");
      if (commandId) {
        shortcut = lazy.ShortcutUtils.findShortcut(
          document.getElementById(commandId)
        );
      }
    }
    if (!shortcut) {
      return;
    }

    aTargetNode.setAttribute(
      "shortcut",
      lazy.ShortcutUtils.prettifyShortcut(shortcut)
    );
  },

  doWidgetCommand(aWidget, aNode, aEvent) {
    if (aWidget.onCommand) {
      try {
        aWidget.onCommand.call(null, aEvent);
      } catch (e) {
        lazy.log.error(e);
      }
    } else {
      // XXXunf Need to think this through more, and formalize.
      Services.obs.notifyObservers(
        aNode,
        "customizedui-widget-command",
        aWidget.id
      );
    }
  },

  showWidgetView(aWidget, aNode, aEvent) {
    let ownerWindow = aNode.ownerGlobal;
    let area = this.getPlacementOfWidget(aNode.id).area;
    let areaType = CustomizableUI.getAreaType(area);
    let anchor = aNode;

    if (
      aWidget.disallowSubView &&
      (areaType == CustomizableUI.TYPE_PANEL ||
        aNode.hasAttribute("overflowedItem"))
    ) {
      // Close the containing panel (e.g. overflow), PanelUI will reopen.
      let wrapper = this.wrapWidget(aWidget.id).forWindow(ownerWindow);
      if (wrapper?.anchor) {
        this.hidePanelForNode(aNode);
        anchor = wrapper.anchor;
      }
    } else if (areaType != CustomizableUI.TYPE_PANEL) {
      let wrapper = this.wrapWidget(aWidget.id).forWindow(ownerWindow);

      let hasMultiView = !!aNode.closest("panelmultiview");
      if (!hasMultiView && wrapper?.anchor) {
        this.hidePanelForNode(aNode);
        anchor = wrapper.anchor;
      }
    }
    ownerWindow.PanelUI.showSubView(aWidget.viewId, anchor, aEvent);
  },

  handleWidgetCommand(aWidget, aNode, aEvent) {
    // Note that aEvent can be a keypress event for widgets of type "view".
    lazy.log.debug("handleWidgetCommand");

    let action;
    if (aWidget.onBeforeCommand) {
      try {
        action = aWidget.onBeforeCommand.call(null, aEvent, aNode);
      } catch (e) {
        lazy.log.error(e);
      }
    }

    if (aWidget.type == "button" || action == "command") {
      this.doWidgetCommand(aWidget, aNode, aEvent);
    } else if (aWidget.type == "view" || action == "view") {
      this.showWidgetView(aWidget, aNode, aEvent);
    } else if (aWidget.type == "button-and-view") {
      // Do the command if we're in the toolbar and the button was clicked.
      // Otherwise, including when we have currently overflowed out of the
      // toolbar, open the view. There is no way to trigger the command while
      // the widget is in the panel, by design.
      let button = aNode.firstElementChild;
      let area = this.getPlacementOfWidget(aNode.id).area;
      let areaType = CustomizableUI.getAreaType(area);
      if (
        areaType == CustomizableUI.TYPE_TOOLBAR &&
        button.contains(aEvent.target) &&
        !aNode.hasAttribute("overflowedItem")
      ) {
        this.doWidgetCommand(aWidget, aNode, aEvent);
      } else {
        this.showWidgetView(aWidget, aNode, aEvent);
      }
    }
  },

  handleWidgetClick(aWidget, aNode, aEvent) {
    lazy.log.debug("handleWidgetClick");
    if (aWidget.onClick) {
      try {
        aWidget.onClick.call(null, aEvent);
      } catch (e) {
        console.error(e);
      }
    } else {
      // XXXunf Need to think this through more, and formalize.
      Services.obs.notifyObservers(
        aNode,
        "customizedui-widget-click",
        aWidget.id
      );
    }
  },

  _getPanelForNode(aNode) {
    return aNode.closest("panel");
  },

  /*
   * If people put things in the panel which need more than single-click interaction,
   * we don't want to close it. Right now we check for text inputs and menu buttons.
   * We also check for being outside of any toolbaritem/toolbarbutton, ie on a blank
   * part of the menu, or on another menu (like a context menu inside the panel).
   */
  _isOnInteractiveElement(aEvent) {
    let panel = this._getPanelForNode(aEvent.currentTarget);
    // This can happen in e.g. customize mode. If there's no panel,
    // there's clearly nothing for us to close; pretend we're interactive.
    if (!panel) {
      return true;
    }

    function getNextTarget(target) {
      if (target.nodeType == target.DOCUMENT_NODE) {
        if (!target.defaultView) {
          // Err, we're done.
          return null;
        }
        // Find containing browser or iframe element in the parent doc.
        return target.defaultView.docShell.chromeEventHandler;
      }
      // Skip any parent shadow roots
      return target.parentNode?.host?.parentNode || target.parentNode;
    }

    // While keeping track of that, we go from the original target back up,
    // to the panel if we have to. We bail as soon as we find an input,
    // a toolbarbutton/item, or a menuItem.
    for (
      let target = aEvent.originalTarget;
      target && target != panel;
      target = getNextTarget(target)
    ) {
      if (target.nodeType == target.DOCUMENT_NODE) {
        // Skip out of iframes etc:
        continue;
      }

      // Break out of the loop immediately for disabled items, as we need to
      // keep the menu open in that case.
      if (target.getAttribute("disabled") == "true") {
        return true;
      }

      let tagName = target.localName;
      if (tagName == "input" || tagName == "searchbar") {
        return true;
      }
      if (tagName == "toolbaritem" || tagName == "toolbarbutton") {
        // If we are in a type="menu" toolbarbutton, we'll now interact with
        // the menu.
        return target.getAttribute("type") == "menu";
      }
      if (tagName == "menuitem") {
        // If we're in a nested menu we don't need to close this panel.
        return true;
      }
    }

    // We don't know what we interacted with, assume interactive.
    return true;
  },

  hidePanelForNode(aNode) {
    let panel = this._getPanelForNode(aNode);
    if (panel) {
      lazy.PanelMultiView.hidePopup(panel);
    }
  },

  maybeAutoHidePanel(aEvent) {
    let eventType = aEvent.type;
    if (eventType == "keypress" && aEvent.keyCode != aEvent.DOM_VK_RETURN) {
      return;
    }

    if (eventType == "click" && aEvent.button != 0) {
      return;
    }

    // We don't check preventDefault - it makes sense that this was prevented,
    // but we probably still want to close the panel. If consumers don't want
    // this to happen, they should specify the closemenu attribute.
    if (eventType != "command" && this._isOnInteractiveElement(aEvent)) {
      return;
    }

    // We can't use event.target because we might have passed an anonymous
    // content boundary as well, and so target points to the outer element in
    // that case. Unfortunately, this means we get anonymous child nodes instead
    // of the real ones, so looking for the 'stoooop, don't close me' attributes
    // is more involved.
    let target = aEvent.originalTarget;
    while (target.parentNode && target.localName != "panel") {
      if (
        target.getAttribute("closemenu") == "none" ||
        target.getAttribute("widget-type") == "view" ||
        target.getAttribute("widget-type") == "button-and-view" ||
        target.hasAttribute("view-button-id")
      ) {
        return;
      }
      target = target.parentNode;
    }

    // If we get here, we can actually hide the popup:
    this.hidePanelForNode(aEvent.target);
  },

  getUnusedWidgets(aWindowPalette) {
    let window = aWindowPalette.ownerGlobal;
    let isWindowPrivate = lazy.PrivateBrowsingUtils.isWindowPrivate(window);
    // We use a Set because there can be overlap between the widgets in
    // gPalette and the items in the palette, especially after the first
    // customization, since programmatically generated widgets will remain
    // in the toolbox palette.
    let widgets = new Set();

    // It's possible that some widgets have been defined programmatically and
    // have not been overlayed into the palette. We can find those inside
    // gPalette.
    for (let [id, widget] of gPalette) {
      if (!widget.currentArea) {
        if (widget.showInPrivateBrowsing || !isWindowPrivate) {
          widgets.add(id);
        }
      }
    }

    lazy.log.debug("Iterating the actual nodes of the window palette");
    for (let node of aWindowPalette.children) {
      lazy.log.debug("In palette children: " + node.id);
      if (node.id && !this.getPlacementOfWidget(node.id)) {
        widgets.add(node.id);
      }
    }

    return [...widgets];
  },

  getPlacementOfWidget(aWidgetId, aOnlyRegistered, aDeadAreas) {
    if (aOnlyRegistered && !this.widgetExists(aWidgetId)) {
      return null;
    }

    for (let [area, placements] of gPlacements) {
      if (!gAreas.has(area) && !aDeadAreas) {
        continue;
      }
      let index = placements.indexOf(aWidgetId);
      if (index != -1) {
        return { area, position: index };
      }
    }

    return null;
  },

  widgetExists(aWidgetId) {
    if (gPalette.has(aWidgetId) || this.isSpecialWidget(aWidgetId)) {
      return true;
    }

    // Destroyed API widgets are in gSeenWidgets, but not in gPalette:
    // The Pocket button is a default API widget that acts like a custom widget.
    // If it's not in gPalette, it doesn't exist.
    if (gSeenWidgets.has(aWidgetId) || aWidgetId === "save-to-pocket-button") {
      return false;
    }

    // We're assuming XUL widgets always exist, as it's much harder to check,
    // and checking would be much more error prone.
    return true;
  },

  addWidgetToArea(aWidgetId, aArea, aPosition, aInitialAdd) {
    if (aArea == CustomizableUI.AREA_NO_AREA) {
      throw new Error(
        "AREA_NO_AREA is only used as an argument for " +
          "canWidgetMoveToArea. Use removeWidgetFromArea instead."
      );
    }
    if (!gAreas.has(aArea)) {
      throw new Error("Unknown customization area: " + aArea);
    }

    // Hack: don't want special widgets in the panel (need to check here as well
    // as in canWidgetMoveToArea because the menu panel is lazy):
    if (
      gAreas.get(aArea).get("type") == CustomizableUI.TYPE_PANEL &&
      this.isSpecialWidget(aWidgetId)
    ) {
      return;
    }

    // If this is a lazy area that hasn't been restored yet, we can't yet modify
    // it - would would at least like to add to it. So we keep track of it in
    // gFuturePlacements,  and use that to add it when restoring the area. We
    // throw away aPosition though, as that can only be bogus if the area hasn't
    // yet been restorted (caller can't possibly know where its putting the
    // widget in relation to other widgets).
    if (this.isAreaLazy(aArea)) {
      gFuturePlacements.get(aArea).add(aWidgetId);
      return;
    }

    if (this.isSpecialWidget(aWidgetId)) {
      aWidgetId = this.ensureSpecialWidgetId(aWidgetId);
    }

    let oldPlacement = this.getPlacementOfWidget(aWidgetId, false, true);
    if (oldPlacement && oldPlacement.area == aArea) {
      this.moveWidgetWithinArea(aWidgetId, aPosition);
      return;
    }

    // Do nothing if the widget is not allowed to move to the target area.
    if (!this.canWidgetMoveToArea(aWidgetId, aArea)) {
      return;
    }

    if (oldPlacement) {
      this.removeWidgetFromArea(aWidgetId);
    }

    if (!gPlacements.has(aArea)) {
      gPlacements.set(aArea, [aWidgetId]);
      aPosition = 0;
    } else {
      let placements = gPlacements.get(aArea);
      if (typeof aPosition != "number") {
        aPosition = placements.length;
      }
      if (aPosition < 0) {
        aPosition = 0;
      }
      placements.splice(aPosition, 0, aWidgetId);
    }

    let widget = gPalette.get(aWidgetId);
    if (widget) {
      widget.currentArea = aArea;
      widget.currentPosition = aPosition;
    }

    // We initially set placements with addWidgetToArea, so in that case
    // we don't consider the area "dirtied".
    if (!aInitialAdd) {
      gDirtyAreaCache.add(aArea);
    }

    gDirty = true;
    this.saveState();

    this.notifyListeners("onWidgetAdded", aWidgetId, aArea, aPosition);
  },

  removeWidgetFromArea(aWidgetId) {
    let oldPlacement = this.getPlacementOfWidget(aWidgetId, false, true);
    if (!oldPlacement) {
      return;
    }

    if (!this.isWidgetRemovable(aWidgetId)) {
      return;
    }

    let placements = gPlacements.get(oldPlacement.area);
    let position = placements.indexOf(aWidgetId);
    if (position != -1) {
      placements.splice(position, 1);
    }

    let widget = gPalette.get(aWidgetId);
    if (widget) {
      widget.currentArea = null;
      widget.currentPosition = null;
    }

    gDirty = true;
    this.saveState();
    gDirtyAreaCache.add(oldPlacement.area);

    this.notifyListeners("onWidgetRemoved", aWidgetId, oldPlacement.area);
  },

  moveWidgetWithinArea(aWidgetId, aPosition) {
    let oldPlacement = this.getPlacementOfWidget(aWidgetId);
    if (!oldPlacement) {
      return;
    }

    let placements = gPlacements.get(oldPlacement.area);
    if (typeof aPosition != "number") {
      aPosition = placements.length;
    } else if (aPosition < 0) {
      aPosition = 0;
    } else if (aPosition > placements.length) {
      aPosition = placements.length;
    }

    let widget = gPalette.get(aWidgetId);
    if (widget) {
      widget.currentPosition = aPosition;
      widget.currentArea = oldPlacement.area;
    }

    if (aPosition == oldPlacement.position) {
      return;
    }

    placements.splice(oldPlacement.position, 1);
    // If we just removed the item from *before* where it is now added,
    // we need to compensate the position offset for that:
    if (oldPlacement.position < aPosition) {
      aPosition--;
    }
    placements.splice(aPosition, 0, aWidgetId);

    gDirty = true;
    gDirtyAreaCache.add(oldPlacement.area);

    this.saveState();

    this.notifyListeners(
      "onWidgetMoved",
      aWidgetId,
      oldPlacement.area,
      oldPlacement.position,
      aPosition
    );
  },

  // Note that this does not populate gPlacements, which is done lazily.
  // The panel area is an exception here.
  loadSavedState() {
    let state = Services.prefs.getCharPref(kPrefCustomizationState, "");
    if (!state) {
      lazy.log.debug("No saved state found");
      // Nothing has been customized, so silently fall back to the defaults.
      return;
    }
    try {
      gSavedState = JSON.parse(state);
      if (typeof gSavedState != "object" || gSavedState === null) {
        throw new Error("Invalid saved state");
      }
    } catch (e) {
      Services.prefs.clearUserPref(kPrefCustomizationState);
      gSavedState = {};
      lazy.log.debug(
        "Error loading saved UI customization state, falling back to defaults."
      );
    }

    if (!("placements" in gSavedState)) {
      gSavedState.placements = {};
    }

    if (!("currentVersion" in gSavedState)) {
      gSavedState.currentVersion = 0;
    }

    gSeenWidgets = new Set(gSavedState.seen || []);
    gDirtyAreaCache = new Set(gSavedState.dirtyAreaCache || []);
    gNewElementCount = gSavedState.newElementCount || 0;
  },

  restoreStateForArea(aArea) {
    let placementsPreexisted = gPlacements.has(aArea);

    this.beginBatchUpdate();
    try {
      gRestoring = true;

      let restored = false;
      if (placementsPreexisted) {
        lazy.log.debug("Restoring " + aArea + " from pre-existing placements");
        for (let [position, id] of gPlacements.get(aArea).entries()) {
          this.moveWidgetWithinArea(id, position);
        }
        gDirty = false;
        restored = true;
      } else {
        gPlacements.set(aArea, []);
      }

      if (!restored && gSavedState && aArea in gSavedState.placements) {
        lazy.log.debug("Restoring " + aArea + " from saved state");
        let placements = gSavedState.placements[aArea];
        for (let id of placements) {
          this.addWidgetToArea(id, aArea);
        }
        gDirty = false;
        restored = true;
      }

      if (!restored) {
        lazy.log.debug("Restoring " + aArea + " from default state");
        let defaults = gAreas.get(aArea).get("defaultPlacements");
        if (defaults) {
          for (let id of defaults) {
            this.addWidgetToArea(id, aArea, null, true);
          }
        }
        gDirty = false;
      }

      // Finally, add widgets to the area that were added before the it was able
      // to be restored. This can occur when add-ons register widgets for a
      // lazily-restored area before it's been restored.
      if (gFuturePlacements.has(aArea)) {
        let areaPlacements = gPlacements.get(aArea);
        for (let id of gFuturePlacements.get(aArea)) {
          if (areaPlacements.includes(id)) {
            continue;
          }
          this.addWidgetToArea(id, aArea);
        }
        gFuturePlacements.delete(aArea);
      }

      lazy.log.debug(
        "Placements for " +
          aArea +
          ":\n\t" +
          gPlacements.get(aArea).join("\n\t")
      );

      gRestoring = false;
    } finally {
      this.endBatchUpdate();
    }
  },

  saveState() {
    if (gInBatchStack || !gDirty) {
      return;
    }
    // Clone because we want to modify this map:
    let state = {
      placements: new Map(gPlacements),
      seen: gSeenWidgets,
      dirtyAreaCache: gDirtyAreaCache,
      currentVersion: kVersion,
      newElementCount: gNewElementCount,
    };

    // Merge in previously saved areas if not present in gPlacements.
    // This way, state is still persisted for e.g. temporarily disabled
    // add-ons - see bug 989338.
    if (gSavedState && gSavedState.placements) {
      for (let area of Object.keys(gSavedState.placements)) {
        if (!state.placements.has(area)) {
          let placements = gSavedState.placements[area];
          state.placements.set(area, placements);
        }
      }
    }

    lazy.log.debug("Saving state.");
    let serialized = JSON.stringify(state, this.serializerHelper);
    lazy.log.debug("State saved as: " + serialized);
    Services.prefs.setCharPref(kPrefCustomizationState, serialized);
    gDirty = false;
  },

  serializerHelper(aKey, aValue) {
    if (typeof aValue == "object" && aValue.constructor.name == "Map") {
      let result = {};
      for (let [mapKey, mapValue] of aValue) {
        result[mapKey] = mapValue;
      }
      return result;
    }

    if (typeof aValue == "object" && aValue.constructor.name == "Set") {
      return [...aValue];
    }

    return aValue;
  },

  beginBatchUpdate() {
    gInBatchStack++;
  },

  endBatchUpdate(aForceDirty) {
    gInBatchStack--;
    if (aForceDirty === true) {
      gDirty = true;
    }
    if (gInBatchStack == 0) {
      this.saveState();
    } else if (gInBatchStack < 0) {
      throw new Error(
        "The batch editing stack should never reach a negative number."
      );
    }
  },

  addListener(aListener) {
    gListeners.add(aListener);
  },

  removeListener(aListener) {
    if (aListener == this) {
      return;
    }

    gListeners.delete(aListener);
  },

  notifyListeners(aEvent, ...aArgs) {
    if (gRestoring) {
      return;
    }

    for (let listener of gListeners) {
      try {
        if (typeof listener[aEvent] == "function") {
          listener[aEvent].apply(listener, aArgs);
        }
      } catch (e) {
        lazy.log.error(e + " -- " + e.fileName + ":" + e.lineNumber);
      }
    }
  },

  _dispatchToolboxEventToWindow(aEventType, aDetails, aWindow) {
    let evt = new aWindow.CustomEvent(aEventType, {
      bubbles: true,
      cancelable: true,
      detail: aDetails,
    });
    aWindow.gNavToolbox.dispatchEvent(evt);
  },

  dispatchToolboxEvent(aEventType, aDetails = {}, aWindow = null) {
    if (aWindow) {
      this._dispatchToolboxEventToWindow(aEventType, aDetails, aWindow);
      return;
    }
    for (let [win] of gBuildWindows) {
      this._dispatchToolboxEventToWindow(aEventType, aDetails, win);
    }
  },

  createWidget(aProperties) {
    let widget = this.normalizeWidget(
      aProperties,
      CustomizableUI.SOURCE_EXTERNAL
    );
    // XXXunf This should probably throw.
    if (!widget) {
      lazy.log.error("unable to normalize widget");
      return undefined;
    }

    gPalette.set(widget.id, widget);

    // Clear our caches:
    gGroupWrapperCache.delete(widget.id);
    for (let [win] of gBuildWindows) {
      let cache = gSingleWrapperCache.get(win);
      if (cache) {
        cache.delete(widget.id);
      }
    }

    this.notifyListeners("onWidgetCreated", widget.id);

    if (widget.defaultArea) {
      let addToDefaultPlacements = false;
      let area = gAreas.get(widget.defaultArea);
      if (
        !CustomizableUI.isBuiltinToolbar(widget.defaultArea) &&
        widget.defaultArea != CustomizableUI.AREA_FIXED_OVERFLOW_PANEL
      ) {
        addToDefaultPlacements = true;
      }

      if (addToDefaultPlacements) {
        if (area.has("defaultPlacements")) {
          area.get("defaultPlacements").push(widget.id);
        } else {
          area.set("defaultPlacements", [widget.id]);
        }
      }
    }

    // Look through previously saved state to see if we're restoring a widget.
    let seenAreas = new Set();
    let widgetMightNeedAutoAdding = true;
    for (let [area] of gPlacements) {
      seenAreas.add(area);
      let areaIsRegistered = gAreas.has(area);
      let index = gPlacements.get(area).indexOf(widget.id);
      if (index != -1) {
        widgetMightNeedAutoAdding = false;
        if (areaIsRegistered) {
          widget.currentArea = area;
          widget.currentPosition = index;
        }
        break;
      }
    }

    // Also look at saved state data directly in areas that haven't yet been
    // restored. Can't rely on this for restored areas, as they may have
    // changed.
    if (widgetMightNeedAutoAdding && gSavedState) {
      for (let area of Object.keys(gSavedState.placements)) {
        if (seenAreas.has(area)) {
          continue;
        }

        let areaIsRegistered = gAreas.has(area);
        let index = gSavedState.placements[area].indexOf(widget.id);
        if (index != -1) {
          widgetMightNeedAutoAdding = false;
          if (areaIsRegistered) {
            widget.currentArea = area;
            widget.currentPosition = index;
          }
          break;
        }
      }
    }

    // If we're restoring the widget to it's old placement, fire off the
    // onWidgetAdded event - our own handler will take care of adding it to
    // any build areas.
    this.beginBatchUpdate();
    try {
      if (widget.currentArea) {
        this.notifyListeners(
          "onWidgetAdded",
          widget.id,
          widget.currentArea,
          widget.currentPosition
        );
      } else if (widgetMightNeedAutoAdding) {
        let autoAdd = Services.prefs.getBoolPref(
          kPrefCustomizationAutoAdd,
          true
        );

        // If the widget doesn't have an existing placement, and it hasn't been
        // seen before, then add it to its default area so it can be used.
        // If the widget is not removable, we *have* to add it to its default
        // area here.
        let canBeAutoAdded = autoAdd && !gSeenWidgets.has(widget.id);
        if (!widget.currentArea && (!widget.removable || canBeAutoAdded)) {
          if (widget.defaultArea) {
            if (this.isAreaLazy(widget.defaultArea)) {
              gFuturePlacements.get(widget.defaultArea).add(widget.id);
            } else {
              this.addWidgetToArea(widget.id, widget.defaultArea);
            }
          }
        }

        // Extension widgets cannot enter the customization palette, so if
        // at this point, we haven't found an area for them, move them into
        // AREA_ADDONS.
        if (
          !widget.currentArea &&
          CustomizableUI.isWebExtensionWidget(widget.id)
        ) {
          this.addWidgetToArea(widget.id, CustomizableUI.AREA_ADDONS);
        }
      }
    } finally {
      // Ensure we always have this widget in gSeenWidgets, and save
      // state in case this needs to be done here.
      gSeenWidgets.add(widget.id);
      this.endBatchUpdate(true);
    }

    this.notifyListeners(
      "onWidgetAfterCreation",
      widget.id,
      widget.currentArea
    );
    return widget.id;
  },

  createBuiltinWidget(aData) {
    // This should only ever be called on startup, before any windows are
    // opened - so we know there's no build areas to handle. Also, builtin
    // widgets are expected to be (mostly) static, so shouldn't affect the
    // current placement settings.

    // This allows a widget to be both built-in by default but also able to be
    // destroyed and removed from the area based on criteria that may not be
    // available when the widget is created -- for example, because some other
    // feature in the browser supersedes the widget.
    let conditionalDestroyPromise = aData.conditionalDestroyPromise || null;
    delete aData.conditionalDestroyPromise;

    let widget = this.normalizeWidget(aData, CustomizableUI.SOURCE_BUILTIN);
    if (!widget) {
      lazy.log.error("Error creating builtin widget: " + aData.id);
      return;
    }

    lazy.log.debug("Creating built-in widget with id: " + widget.id);
    gPalette.set(widget.id, widget);

    if (conditionalDestroyPromise) {
      conditionalDestroyPromise.then(
        shouldDestroy => {
          if (shouldDestroy) {
            this.destroyWidget(widget.id);
            this.removeWidgetFromArea(widget.id);
          }
        },
        err => {
          console.error(err);
        }
      );
    }
  },

  // Returns true if the area will eventually lazily restore (but hasn't yet).
  isAreaLazy(aArea) {
    if (gPlacements.has(aArea)) {
      return false;
    }
    return gAreas.get(aArea).get("type") == CustomizableUI.TYPE_TOOLBAR;
  },

  // XXXunf Log some warnings here, when the data provided isn't up to scratch.
  normalizeWidget(aData, aSource) {
    let widget = {
      implementation: aData,
      source: aSource || CustomizableUI.SOURCE_EXTERNAL,
      instances: new Map(),
      currentArea: null,
      localized: true,
      removable: true,
      overflows: true,
      defaultArea: null,
      shortcutId: null,
      tabSpecific: false,
      locationSpecific: false,
      tooltiptext: null,
      l10nId: null,
      showInPrivateBrowsing: true,
      _introducedInVersion: -1,
      _introducedByPref: null,
      keepBroadcastAttributesWhenCustomizing: false,
      disallowSubView: false,
      webExtension: false,
    };

    if (typeof aData.id != "string" || !/^[a-z0-9-_]{1,}$/i.test(aData.id)) {
      lazy.log.error("Given an illegal id in normalizeWidget: " + aData.id);
      return null;
    }

    delete widget.implementation.currentArea;
    widget.implementation.__defineGetter__(
      "currentArea",
      () => widget.currentArea
    );

    const kReqStringProps = ["id"];
    for (let prop of kReqStringProps) {
      if (typeof aData[prop] != "string") {
        lazy.log.error(
          "Missing required property '" +
            prop +
            "' in normalizeWidget: " +
            aData.id
        );
        return null;
      }
      widget[prop] = aData[prop];
    }

    const kOptStringProps = ["l10nId", "label", "tooltiptext", "shortcutId"];
    for (let prop of kOptStringProps) {
      if (typeof aData[prop] == "string") {
        widget[prop] = aData[prop];
      }
    }

    const kOptBoolProps = [
      "removable",
      "showInPrivateBrowsing",
      "overflows",
      "tabSpecific",
      "locationSpecific",
      "localized",
      "keepBroadcastAttributesWhenCustomizing",
      "disallowSubView",
      "webExtension",
    ];
    for (let prop of kOptBoolProps) {
      if (typeof aData[prop] == "boolean") {
        widget[prop] = aData[prop];
      }
    }

    // When we normalize builtin widgets, areas have not yet been registered:
    if (
      aData.defaultArea &&
      (aSource == CustomizableUI.SOURCE_BUILTIN ||
        gAreas.has(aData.defaultArea))
    ) {
      widget.defaultArea = aData.defaultArea;
    } else if (!widget.removable) {
      lazy.log.error(
        "Widget '" +
          widget.id +
          "' is not removable but does not specify " +
          "a valid defaultArea. That's not possible; it must specify a " +
          "valid defaultArea as well."
      );
      return null;
    }

    if ("type" in aData && gSupportedWidgetTypes.has(aData.type)) {
      widget.type = aData.type;
    } else {
      widget.type = "button";
    }

    widget.disabled = aData.disabled === true;

    if (aSource == CustomizableUI.SOURCE_BUILTIN) {
      widget._introducedInVersion = aData.introducedInVersion || 0;

      if (aData._introducedByPref) {
        widget._introducedByPref = aData._introducedByPref;
      }
    }

    this.wrapWidgetEventHandler("onBeforeCreated", widget);
    this.wrapWidgetEventHandler("onClick", widget);
    this.wrapWidgetEventHandler("onCreated", widget);
    this.wrapWidgetEventHandler("onDestroyed", widget);

    if (typeof aData.onBeforeCommand == "function") {
      widget.onBeforeCommand = aData.onBeforeCommand;
    }

    if (typeof aData.onCommand == "function") {
      widget.onCommand = aData.onCommand;
    }
    if (
      widget.type == "view" ||
      widget.type == "button-and-view" ||
      aData.viewId
    ) {
      if (typeof aData.viewId != "string") {
        lazy.log.error(
          "Expected a string for widget " +
            widget.id +
            " viewId, but got " +
            aData.viewId
        );
        return null;
      }
      widget.viewId = aData.viewId;

      this.wrapWidgetEventHandler("onViewShowing", widget);
      this.wrapWidgetEventHandler("onViewHiding", widget);
    }
    if (widget.type == "custom") {
      this.wrapWidgetEventHandler("onBuild", widget);
    }

    if (gPalette.has(widget.id)) {
      return null;
    }

    return widget;
  },

  wrapWidgetEventHandler(aEventName, aWidget) {
    if (typeof aWidget.implementation[aEventName] != "function") {
      aWidget[aEventName] = null;
      return;
    }
    aWidget[aEventName] = function (...aArgs) {
      try {
        // Don't copy the function to the normalized widget object, instead
        // keep it on the original object provided to the API so that
        // additional methods can be implemented and used by the event
        // handlers.
        return aWidget.implementation[aEventName].apply(
          aWidget.implementation,
          aArgs
        );
      } catch (e) {
        console.error(e);
        return undefined;
      }
    };
  },

  destroyWidget(aWidgetId) {
    let widget = gPalette.get(aWidgetId);
    if (!widget) {
      gGroupWrapperCache.delete(aWidgetId);
      for (let [window] of gBuildWindows) {
        let windowCache = gSingleWrapperCache.get(window);
        if (windowCache) {
          windowCache.delete(aWidgetId);
        }
      }
      return;
    }

    // Remove it from the default placements of an area if it was added there:
    if (widget.defaultArea) {
      let area = gAreas.get(widget.defaultArea);
      if (area) {
        let defaultPlacements = area.get("defaultPlacements");
        // We can assume this is present because if a widget has a defaultArea,
        // we automatically create a defaultPlacements array for that area.
        let widgetIndex = defaultPlacements.indexOf(aWidgetId);
        if (widgetIndex != -1) {
          defaultPlacements.splice(widgetIndex, 1);
        }
      }
    }

    // This will not remove the widget from gPlacements - we want to keep the
    // setting so the widget gets put back in it's old position if/when it
    // returns.
    for (let [window] of gBuildWindows) {
      let windowCache = gSingleWrapperCache.get(window);
      if (windowCache) {
        windowCache.delete(aWidgetId);
      }
      let widgetNode =
        window.document.getElementById(aWidgetId) ||
        window.gNavToolbox.palette.getElementsByAttribute("id", aWidgetId)[0];
      if (widgetNode) {
        let container = widgetNode.parentNode;
        this.notifyListeners(
          "onWidgetBeforeDOMChange",
          widgetNode,
          null,
          container,
          true
        );
        widgetNode.remove();
        this.notifyListeners(
          "onWidgetAfterDOMChange",
          widgetNode,
          null,
          container,
          true
        );
      }
      if (
        widget.type == "view" ||
        widget.type == "button-and-view" ||
        widget.viewId
      ) {
        let viewNode = window.document.getElementById(widget.viewId);
        if (viewNode) {
          for (let eventName of kSubviewEvents) {
            let handler = "on" + eventName;
            if (typeof widget[handler] == "function") {
              viewNode.removeEventListener(eventName, widget[handler]);
            }
          }
          viewNode._addedEventListeners = false;
        }
      }
      if (widgetNode && widget.onDestroyed) {
        widget.onDestroyed(window.document);
      }
    }

    gPalette.delete(aWidgetId);
    gGroupWrapperCache.delete(aWidgetId);

    this.notifyListeners("onWidgetDestroyed", aWidgetId);
  },

  getCustomizeTargetForArea(aArea, aWindow) {
    let buildAreaNodes = gBuildAreas.get(aArea);
    if (!buildAreaNodes) {
      return null;
    }

    for (let node of buildAreaNodes) {
      if (node.ownerGlobal == aWindow) {
        return this.getCustomizationTarget(node) || node;
      }
    }

    return null;
  },

  reset() {
    gResetting = true;
    this._resetUIState();

    // Rebuild each registered area (across windows) to reflect the state that
    // was reset above.
    this._rebuildRegisteredAreas();

    for (let [widgetId, widget] of gPalette) {
      if (widget.source == CustomizableUI.SOURCE_EXTERNAL) {
        gSeenWidgets.add(widgetId);
      }
    }
    if (gSeenWidgets.size || gNewElementCount) {
      gDirty = true;
      this.saveState();
    }

    gResetting = false;
  },

  _resetUIState() {
    try {
      gUIStateBeforeReset.drawInTitlebar =
        Services.prefs.getIntPref(kPrefDrawInTitlebar);
      gUIStateBeforeReset.uiCustomizationState = Services.prefs.getCharPref(
        kPrefCustomizationState
      );
      gUIStateBeforeReset.uiDensity = Services.prefs.getIntPref(kPrefUIDensity);
      gUIStateBeforeReset.autoTouchMode =
        Services.prefs.getBoolPref(kPrefAutoTouchMode);
      gUIStateBeforeReset.currentTheme = gSelectedTheme;
      gUIStateBeforeReset.autoHideDownloadsButton = Services.prefs.getBoolPref(
        kPrefAutoHideDownloadsButton
      );
      gUIStateBeforeReset.newElementCount = gNewElementCount;
    } catch (e) {}

    Services.prefs.clearUserPref(kPrefCustomizationState);
    Services.prefs.clearUserPref(kPrefDrawInTitlebar);
    Services.prefs.clearUserPref(kPrefUIDensity);
    Services.prefs.clearUserPref(kPrefAutoTouchMode);
    Services.prefs.clearUserPref(kPrefAutoHideDownloadsButton);
    gDefaultTheme.enable();
    gNewElementCount = 0;
    lazy.log.debug("State reset");

    // Later in the function, we're going to add any area-less extension
    // buttons to the AREA_ADDONS area. We'll remember the old placements
    // for that area so that we don't need to re-add widgets that are already
    // in there in the DOM.
    let oldAddonPlacements = gPlacements[CustomizableUI.AREA_ADDONS] || [];

    // Reset placements to make restoring default placements possible.
    gPlacements = new Map();
    gDirtyAreaCache = new Set();
    gSeenWidgets = new Set();
    // Clear the saved state to ensure that defaults will be used.
    gSavedState = null;
    // Restore the state for each area to its defaults
    for (let [areaId] of gAreas) {
      // If the Unified Extensions UI is enabled, we'll be adding any
      // extension buttons that aren't already in AREA_ADDONS there,
      // so we can skip restoring the state for it.
      if (areaId != CustomizableUI.AREA_ADDONS) {
        this.restoreStateForArea(areaId);
      }
    }

    // restoreStateForArea will have normally set an array for the placements
    // for each area, but since we skip AREA_ADDONS intentionally, that array
    // doesn't get set, so we do that manually here.
    gPlacements.set(CustomizableUI.AREA_ADDONS, []);

    for (let [widgetId] of gPalette) {
      if (
        CustomizableUI.isWebExtensionWidget(widgetId) &&
        !oldAddonPlacements.includes(widgetId)
      ) {
        this.addWidgetToArea(widgetId, CustomizableUI.AREA_ADDONS);
      }
    }
  },

  _rebuildRegisteredAreas() {
    for (let [areaId, areaNodes] of gBuildAreas) {
      let placements = gPlacements.get(areaId);
      let isFirstChangedToolbar = true;
      for (let areaNode of areaNodes) {
        this.buildArea(areaId, placements, areaNode);

        let area = gAreas.get(areaId);
        if (area.get("type") == CustomizableUI.TYPE_TOOLBAR) {
          let defaultCollapsed = area.get("defaultCollapsed");
          let win = areaNode.ownerGlobal;
          if (defaultCollapsed !== null) {
            win.setToolbarVisibility(
              areaNode,
              typeof defaultCollapsed == "string"
                ? defaultCollapsed
                : !defaultCollapsed,
              isFirstChangedToolbar
            );
          }
        }
        isFirstChangedToolbar = false;
      }
    }
  },

  /**
   * Undoes a previous reset, restoring the state of the UI to the state prior to the reset.
   */
  undoReset() {
    if (
      gUIStateBeforeReset.uiCustomizationState == null ||
      gUIStateBeforeReset.drawInTitlebar == null
    ) {
      return;
    }
    gUndoResetting = true;

    const {
      uiCustomizationState,
      drawInTitlebar,
      currentTheme,
      uiDensity,
      autoTouchMode,
      autoHideDownloadsButton,
    } = gUIStateBeforeReset;
    gNewElementCount = gUIStateBeforeReset.newElementCount;

    // Need to clear the previous state before setting the prefs
    // because pref observers may check if there is a previous UI state.
    this._clearPreviousUIState();

    Services.prefs.setCharPref(kPrefCustomizationState, uiCustomizationState);
    Services.prefs.setIntPref(kPrefDrawInTitlebar, drawInTitlebar);
    Services.prefs.setIntPref(kPrefUIDensity, uiDensity);
    Services.prefs.setBoolPref(kPrefAutoTouchMode, autoTouchMode);
    Services.prefs.setBoolPref(
      kPrefAutoHideDownloadsButton,
      autoHideDownloadsButton
    );
    currentTheme.enable();
    this.loadSavedState();
    // If the user just customizes toolbar/titlebar visibility, gSavedState will be null
    // and we don't need to do anything else here:
    if (gSavedState) {
      for (let areaId of Object.keys(gSavedState.placements)) {
        let placements = gSavedState.placements[areaId];
        gPlacements.set(areaId, placements);
      }
      this._rebuildRegisteredAreas();
    }

    gUndoResetting = false;
  },

  _clearPreviousUIState() {
    Object.getOwnPropertyNames(gUIStateBeforeReset).forEach(prop => {
      gUIStateBeforeReset[prop] = null;
    });
  },

  /**
   * @param {String|Node} aWidget - widget ID or a widget node (preferred for performance).
   * @return {Boolean} whether the widget is removable
   */
  isWidgetRemovable(aWidget) {
    let widgetId;
    let widgetNode;
    if (typeof aWidget == "string") {
      widgetId = aWidget;
    } else {
      // Skipped items could just not have ids.
      if (!aWidget.id && aWidget.getAttribute("skipintoolbarset") == "true") {
        return false;
      }
      if (
        !aWidget.id &&
        !["toolbarspring", "toolbarspacer", "toolbarseparator"].includes(
          aWidget.nodeName
        )
      ) {
        throw new Error(
          "No nodes without ids that aren't special widgets should ever come into contact with CUI"
        );
      }
      // Use "spring" / "spacer" / "separator" for special widgets without ids
      widgetId =
        aWidget.id || aWidget.nodeName.substring(7 /* "toolbar".length */);
      widgetNode = aWidget;
    }
    let provider = this.getWidgetProvider(widgetId);

    if (provider == CustomizableUI.PROVIDER_API) {
      return gPalette.get(widgetId).removable;
    }

    if (provider == CustomizableUI.PROVIDER_XUL) {
      if (gBuildWindows.size == 0) {
        // We don't have any build windows to look at, so just assume for now
        // that its removable.
        return true;
      }

      if (!widgetNode) {
        // Pick any of the build windows to look at.
        let [window] = [...gBuildWindows][0];
        [, widgetNode] = this.getWidgetNode(widgetId, window);
      }
      // If we don't have a node, we assume it's removable. This can happen because
      // getWidgetProvider returns PROVIDER_XUL by default, but this will also happen
      // for API-provided widgets which have been destroyed.
      if (!widgetNode) {
        return true;
      }
      return widgetNode.getAttribute("removable") == "true";
    }

    // Otherwise this is either a special widget, which is always removable, or
    // an API widget which has already been removed from gPalette. Returning true
    // here allows us to then remove its ID from any placements where it might
    // still occur.
    return true;
  },

  canWidgetMoveToArea(aWidgetId, aArea) {
    // Special widgets can't move to the menu panel.
    if (
      this.isSpecialWidget(aWidgetId) &&
      gAreas.has(aArea) &&
      gAreas.get(aArea).get("type") == CustomizableUI.TYPE_PANEL
    ) {
      return false;
    }

    if (
      aArea == CustomizableUI.AREA_ADDONS &&
      !CustomizableUI.isWebExtensionWidget(aWidgetId)
    ) {
      return false;
    }

    if (CustomizableUI.isWebExtensionWidget(aWidgetId)) {
      // Extension widgets cannot move to the customization palette.
      if (aArea == CustomizableUI.AREA_NO_AREA) {
        return false;
      }

      // Extension widgets cannot move to panels, with the exception of the
      // AREA_ADDONS area.
      if (
        gAreas.get(aArea).get("type") == CustomizableUI.TYPE_PANEL &&
        aArea != CustomizableUI.AREA_ADDONS
      ) {
        return false;
      }
    }

    let placement = this.getPlacementOfWidget(aWidgetId);
    // Items in the palette can move, and items can move within their area:
    if (!placement || placement.area == aArea) {
      return true;
    }
    // For everything else, just return whether the widget is removable.
    return this.isWidgetRemovable(aWidgetId);
  },

  ensureWidgetPlacedInWindow(aWidgetId, aWindow) {
    let placement = this.getPlacementOfWidget(aWidgetId);
    if (!placement) {
      return false;
    }
    let areaNodes = gBuildAreas.get(placement.area);
    if (!areaNodes) {
      return false;
    }
    let container = [...areaNodes].filter(n => n.ownerGlobal == aWindow);
    if (!container.length) {
      return false;
    }
    let existingNode = container[0].getElementsByAttribute("id", aWidgetId)[0];
    if (existingNode) {
      return true;
    }

    this.insertNodeInWindow(aWidgetId, container[0], true);
    return true;
  },

  _getCurrentWidgetsInContainer(container) {
    // Get a list of all the widget IDs in this container, including any that
    // are overflown.
    let currentWidgets = new Set();
    function addUnskippedChildren(parent) {
      for (let node of parent.children) {
        let realNode =
          node.localName == "toolbarpaletteitem"
            ? node.firstElementChild
            : node;
        if (realNode.getAttribute("skipintoolbarset") != "true") {
          currentWidgets.add(realNode.id);
        }
      }
    }
    addUnskippedChildren(this.getCustomizationTarget(container));
    if (container.getAttribute("overflowing") == "true") {
      let overflowTarget = container.getAttribute("default-overflowtarget");
      addUnskippedChildren(
        container.ownerDocument.getElementById(overflowTarget)
      );
      let webExtOverflowTarget = container.getAttribute(
        "addon-webext-overflowtarget"
      );
      addUnskippedChildren(
        container.ownerDocument.getElementById(webExtOverflowTarget)
      );
    }
    // Then get the sorted list of placements, and filter based on the nodes
    // that are present. This avoids including items that don't exist (e.g. ids
    // of add-on items that the user has uninstalled).
    let orderedPlacements = CustomizableUI.getWidgetIdsInArea(container.id);
    return orderedPlacements.filter(w => currentWidgets.has(w));
  },

  get inDefaultState() {
    for (let [areaId, props] of gAreas) {
      let defaultPlacements = props
        .get("defaultPlacements")
        .filter(item => this.widgetExists(item));
      let currentPlacements = gPlacements.get(areaId);
      // We're excluding all of the placement IDs for items that do not exist,
      // and items that have removable="false",
      // because we don't want to consider them when determining if we're
      // in the default state. This way, if an add-on introduces a widget
      // and is then uninstalled, the leftover placement doesn't cause us to
      // automatically assume that the buttons are not in the default state.
      let buildAreaNodes = gBuildAreas.get(areaId);
      if (buildAreaNodes && buildAreaNodes.size) {
        let container = [...buildAreaNodes][0];
        let removableOrDefault = itemNodeOrItem => {
          let item = (itemNodeOrItem && itemNodeOrItem.id) || itemNodeOrItem;
          let isRemovable = this.isWidgetRemovable(itemNodeOrItem);
          let isInDefault = defaultPlacements.includes(item);
          return isRemovable || isInDefault;
        };
        // Toolbars need to deal with overflown widgets (if any) - so
        // specialcase them:
        if (props.get("type") == CustomizableUI.TYPE_TOOLBAR) {
          currentPlacements =
            this._getCurrentWidgetsInContainer(container).filter(
              removableOrDefault
            );
        } else {
          currentPlacements = currentPlacements.filter(item => {
            let itemNode = container.getElementsByAttribute("id", item)[0];
            return itemNode && removableOrDefault(itemNode || item);
          });
        }

        if (props.get("type") == CustomizableUI.TYPE_TOOLBAR) {
          let collapsed = null;
          let defaultCollapsed = props.get("defaultCollapsed");
          let nondefaultState = false;
          if (areaId == CustomizableUI.AREA_BOOKMARKS) {
            collapsed = Services.prefs.getCharPref(
              "browser.toolbars.bookmarks.visibility"
            );
            nondefaultState = Services.prefs.prefHasUserValue(
              "browser.toolbars.bookmarks.visibility"
            );
          } else {
            let attribute =
              container.getAttribute("type") == "menubar"
                ? "autohide"
                : "collapsed";
            collapsed = container.getAttribute(attribute) == "true";
            nondefaultState = collapsed != defaultCollapsed;
          }
          if (defaultCollapsed !== null && nondefaultState) {
            lazy.log.debug(
              "Found " +
                areaId +
                " had non-default toolbar visibility" +
                "(expected " +
                defaultCollapsed +
                ", was " +
                collapsed +
                ")"
            );
            return false;
          }
        }
      }
      lazy.log.debug(
        "Checking default state for " +
          areaId +
          ":\n" +
          currentPlacements.join(",") +
          "\nvs.\n" +
          defaultPlacements.join(",")
      );

      if (currentPlacements.length != defaultPlacements.length) {
        return false;
      }

      for (let i = 0; i < currentPlacements.length; ++i) {
        if (
          currentPlacements[i] != defaultPlacements[i] &&
          !this.matchingSpecials(currentPlacements[i], defaultPlacements[i])
        ) {
          lazy.log.debug(
            "Found " +
              currentPlacements[i] +
              " in " +
              areaId +
              " where " +
              defaultPlacements[i] +
              " was expected!"
          );
          return false;
        }
      }
    }

    if (Services.prefs.prefHasUserValue(kPrefUIDensity)) {
      lazy.log.debug(kPrefUIDensity + " pref is non-default");
      return false;
    }

    if (Services.prefs.prefHasUserValue(kPrefAutoTouchMode)) {
      lazy.log.debug(kPrefAutoTouchMode + " pref is non-default");
      return false;
    }

    if (Services.prefs.prefHasUserValue(kPrefDrawInTitlebar)) {
      lazy.log.debug(kPrefDrawInTitlebar + " pref is non-default");
      return false;
    }

    // This should just be `gDefaultTheme.isActive`, but bugs...
    if (gDefaultTheme && gDefaultTheme.id != gSelectedTheme.id) {
      lazy.log.debug(gSelectedTheme.id + " theme is non-default");
      return false;
    }

    return true;
  },

  getCollapsedToolbarIds(window) {
    let collapsedToolbars = new Set();
    for (let toolbarId of CustomizableUIInternal._builtinToolbars) {
      let toolbar = window.document.getElementById(toolbarId);

      // Menubar toolbars are special in that they're hidden with the autohide
      // attribute.
      let hidingAttribute =
        toolbar.getAttribute("type") == "menubar" ? "autohide" : "collapsed";

      if (toolbar.getAttribute(hidingAttribute) == "true") {
        collapsedToolbars.add(toolbarId);
      }
    }

    return collapsedToolbars;
  },

  setToolbarVisibility(aToolbarId, aIsVisible) {
    // We only persist the attribute the first time.
    let isFirstChangedToolbar = true;
    for (let window of CustomizableUI.windows) {
      let toolbar = window.document.getElementById(aToolbarId);
      if (toolbar) {
        window.setToolbarVisibility(toolbar, aIsVisible, isFirstChangedToolbar);
        isFirstChangedToolbar = false;
      }
    }
  },

  observe(aSubject, aTopic, aData) {
    if (aTopic == "browser-set-toolbar-visibility") {
      let [toolbar, visibility] = JSON.parse(aData);
      CustomizableUI.setToolbarVisibility(toolbar, visibility == "true");
    }
  },
};
Object.freeze(CustomizableUIInternal);

export var CustomizableUI = {
  /**
   * Constant reference to the ID of the navigation toolbar.
   */
  AREA_NAVBAR: "nav-bar",
  /**
   * Constant reference to the ID of the menubar's toolbar.
   */
  AREA_MENUBAR: "toolbar-menubar",
  /**
   * Constant reference to the ID of the tabstrip toolbar.
   */
  AREA_TABSTRIP: "TabsToolbar",
  /**
   * Constant reference to the ID of the bookmarks toolbar.
   */
  AREA_BOOKMARKS: "PersonalToolbar",
  /**
   * Constant reference to the ID of the non-dymanic (fixed) list in the overflow panel.
   */
  AREA_FIXED_OVERFLOW_PANEL: "widget-overflow-fixed-list",
  /**
   * Constant reference to the ID of the addons area.
   */
  AREA_ADDONS: "unified-extensions-area",
  /**
   * Constant reference to the ID of the customization palette, which is
   * where widgets go when they're not assigned to an area. Note that this
   * area is "virtual" in that it's never set as a value for a widgets
   * currentArea or defaultArea. It's only used for the `canWidgetMoveToArea`
   * function to check if widgets can be moved to the palette. Callers who
   * wish to move items to the palette should use `removeWidgetFromArea`.
   */
  AREA_NO_AREA: "customization-palette",
  /**
   * Constant indicating the area is a panel.
   */
  TYPE_PANEL: "panel",
  /**
   * Constant indicating the area is a toolbar.
   */
  TYPE_TOOLBAR: "toolbar",

  /**
   * Constant indicating a XUL-type provider.
   */
  PROVIDER_XUL: "xul",
  /**
   * Constant indicating an API-type provider.
   */
  PROVIDER_API: "api",
  /**
   * Constant indicating dynamic (special) widgets: spring, spacer, and separator.
   */
  PROVIDER_SPECIAL: "special",

  /**
   * Constant indicating the widget is built-in
   */
  SOURCE_BUILTIN: "builtin",
  /**
   * Constant indicating the widget is externally provided
   * (e.g. by add-ons or other items not part of the builtin widget set).
   */
  SOURCE_EXTERNAL: "external",

  /**
   * Constant indicating the reason the event was fired was a window closing
   */
  REASON_WINDOW_CLOSED: "window-closed",
  /**
   * Constant indicating the reason the event was fired was an area being
   * unregistered separately from window closing mechanics.
   */
  REASON_AREA_UNREGISTERED: "area-unregistered",

  /**
   * An iteratable property of windows managed by CustomizableUI.
   * Note that this can *only* be used as an iterator. ie:
   *     for (let window of CustomizableUI.windows) { ... }
   */
  windows: {
    *[Symbol.iterator]() {
      for (let [window] of gBuildWindows) {
        yield window;
      }
    },
  },

  /**
   * Add a listener object that will get fired for various events regarding
   * customization.
   *
   * @param aListener the listener object to add
   *
   * Not all event handler methods need to be defined.
   * CustomizableUI will catch exceptions. Events are dispatched
   * synchronously on the UI thread, so if you can delay any/some of your
   * processing, that is advisable. The following event handlers are supported:
   *   - onWidgetAdded(aWidgetId, aArea, aPosition)
   *     Fired when a widget is added to an area. aWidgetId is the widget that
   *     was added, aArea the area it was added to, and aPosition the position
   *     in which it was added.
   *   - onWidgetMoved(aWidgetId, aArea, aOldPosition, aNewPosition)
   *     Fired when a widget is moved within its area. aWidgetId is the widget
   *     that was moved, aArea the area it was moved in, aOldPosition its old
   *     position, and aNewPosition its new position.
   *   - onWidgetRemoved(aWidgetId, aArea)
   *     Fired when a widget is removed from its area. aWidgetId is the widget
   *     that was removed, aArea the area it was removed from.
   *
   *   - onWidgetBeforeDOMChange(aNode, aNextNode, aContainer, aIsRemoval)
   *     Fired *before* a widget's DOM node is acted upon by CustomizableUI
   *     (to add, move or remove it). aNode is the DOM node changed, aNextNode
   *     the DOM node (if any) before which a widget will be inserted,
   *     aContainer the *actual* DOM container (could be an overflow panel in
   *     case of an overflowable toolbar), and aWasRemoval is true iff the
   *     action about to happen is the removal of the DOM node.
   *   - onWidgetAfterDOMChange(aNode, aNextNode, aContainer, aWasRemoval)
   *     Like onWidgetBeforeDOMChange, but fired after the change to the DOM
   *     node of the widget.
   *
   *   - onWidgetReset(aNode, aContainer)
   *     Fired after a reset to default placements moves a widget's node to a
   *     different location. aNode is the widget's node, aContainer is the
   *     area it was moved into (NB: it might already have been there and been
   *     moved to a different position!)
   *   - onWidgetUndoMove(aNode, aContainer)
   *     Fired after undoing a reset to default placements moves a widget's
   *     node to a different location. aNode is the widget's node, aContainer
   *     is the area it was moved into (NB: it might already have been there
   *     and been moved to a different position!)
   *   - onAreaReset(aArea, aContainer)
   *     Fired after a reset to default placements is complete on an area's
   *     DOM node. Note that this is fired for each DOM node. aArea is the area
   *     that was reset, aContainer the DOM node that was reset.
   *
   *   - onWidgetCreated(aWidgetId)
   *     Fired when a widget with id aWidgetId has been created, but before it
   *     is added to any placements or any DOM nodes have been constructed.
   *     Only fired for API-based widgets.
   *   - onWidgetAfterCreation(aWidgetId, aArea)
   *     Fired after a widget with id aWidgetId has been created, and has been
   *     added to either its default area or the area in which it was placed
   *     previously. If the widget has no default area and/or it has never
   *     been placed anywhere, aArea may be null. Only fired for API-based
   *     widgets.
   *   - onWidgetDestroyed(aWidgetId)
   *     Fired when widgets are destroyed. aWidgetId is the widget that is
   *     being destroyed. Only fired for API-based widgets.
   *   - onWidgetInstanceRemoved(aWidgetId, aDocument)
   *     Fired when a window is unloaded and a widget's instance is destroyed
   *     because of this. Only fired for API-based widgets.
   *
   *   - onWidgetDrag(aWidgetId, aArea)
   *     Fired both when and after customize mode drag handling system tries
   *     to determine the width and height of widget aWidgetId when dragged to a
   *     different area. aArea will be the area the item is dragged to, or
   *     undefined after the measurements have been done and the node has been
   *     moved back to its 'regular' area.
   *
   *   - onCustomizeStart(aWindow)
   *     Fired when opening customize mode in aWindow.
   *   - onCustomizeEnd(aWindow)
   *     Fired when exiting customize mode in aWindow.
   *
   *   - onWidgetOverflow(aNode, aContainer)
   *     Fired when a widget's DOM node is overflowing its container, a toolbar,
   *     and will be displayed in the overflow panel.
   *   - onWidgetUnderflow(aNode, aContainer)
   *     Fired when a widget's DOM node is *not* overflowing its container, a
   *     toolbar, anymore.
   *   - onWindowOpened(aWindow)
   *     Fired when a window has been opened that is managed by CustomizableUI,
   *     once all of the prerequisite setup has been done.
   *   - onWindowClosed(aWindow)
   *     Fired when a window that has been managed by CustomizableUI has been
   *     closed.
   *   - onAreaNodeRegistered(aArea, aContainer)
   *     Fired after an area node is first built when it is registered. This
   *     is often when the window has opened, but in the case of add-ons,
   *     could fire when the node has just been registered with CustomizableUI
   *     after an add-on update or disable/enable sequence.
   *   - onAreaNodeUnregistered(aArea, aContainer, aReason)
   *     Fired when an area node is explicitly unregistered by an API caller,
   *     or by a window closing. The aReason parameter indicates which of
   *     these is the case.
   */
  addListener(aListener) {
    CustomizableUIInternal.addListener(aListener);
  },
  /**
   * Remove a listener added with addListener
   * @param aListener the listener object to remove
   */
  removeListener(aListener) {
    CustomizableUIInternal.removeListener(aListener);
  },

  /**
   * Register a customizable area with CustomizableUI.
   * @param aName   the name of the area to register. Can only contain
   *                alphanumeric characters, dashes (-) and underscores (_).
   * @param aProps  the properties of the area. The following properties are
   *                recognized:
   *                - type:   the type of area. Either TYPE_TOOLBAR (default) or
   *                          TYPE_PANEL;
   *                - anchor: for a menu panel or overflowable toolbar, the
   *                          anchoring node for the panel.
   *                - overflowable: set to true if your toolbar is overflowable.
   *                                This requires an anchor, and only has an
   *                                effect for toolbars.
   *                - defaultPlacements: an array of widget IDs making up the
   *                                     default contents of the area
   *                - defaultCollapsed: (INTERNAL ONLY) applies if the type is TYPE_TOOLBAR, specifies
   *                                    if toolbar is collapsed by default (default to true).
   *                                    Specify null to ensure that reset/inDefaultArea don't care
   *                                    about a toolbar's collapsed state
   */
  registerArea(aName, aProperties) {
    CustomizableUIInternal.registerArea(aName, aProperties);
  },
  /**
   * Register a concrete node for a registered area. This method needs to be called
   * with any toolbar in the main browser window that has its "customizable" attribute
   * set to true.
   *
   * Note that ideally, you should register your toolbar using registerArea
   * before calling this. If you don't, the node will be saved for processing when
   * you call registerArea. Note that CustomizableUI won't restore state in the area,
   * allow the user to customize it in customize mode, or otherwise deal
   * with it, until the area has been registered.
   */
  registerToolbarNode(aToolbar) {
    CustomizableUIInternal.registerToolbarNode(aToolbar);
  },
  /**
   * Register a panel node. A panel treated slightly differently from a toolbar in
   * terms of what items can be moved into it. For example, a panel cannot have a
   * spacer or a spring put into it.
   *
   * @param aPanelContents the panel contents DOM node being registered.
   * @param aArea the area for which to register this node.
   */
  registerPanelNode(aNode, aArea) {
    CustomizableUIInternal.registerPanelNode(aNode, aArea);
  },
  /**
   * Unregister a customizable area. The inverse of registerArea.
   *
   * Unregistering an area will remove all the (removable) widgets in the
   * area, which will return to the panel, and destroy all other traces
   * of the area within CustomizableUI. Note that this means the *contents*
   * of the area's DOM nodes will be moved to the panel or removed, but
   * the area's DOM nodes *themselves* will stay.
   *
   * Furthermore, by default the placements of the area will be kept in the
   * saved state (!) and restored if you re-register the area at a later
   * point. This is useful for e.g. add-ons that get disabled and then
   * re-enabled (e.g. when they update).
   *
   * You can override this last behaviour (and destroy the placements
   * information in the saved state) by passing true for aDestroyPlacements.
   *
   * @param aName              the name of the area to unregister
   * @param aDestroyPlacements whether to destroy the placements information
   *                           for the area, too.
   */
  unregisterArea(aName, aDestroyPlacements) {
    CustomizableUIInternal.unregisterArea(aName, aDestroyPlacements);
  },
  /**
   * Add a widget to an area.
   * If the area to which you try to add is not known to CustomizableUI,
   * this will throw.
   * If the area to which you try to add is the same as the area in which
   * the widget is currently placed, this will do the same as
   * moveWidgetWithinArea.
   * If the widget cannot be removed from its original location, this will
   * no-op.
   *
   * This will fire an onWidgetAdded notification,
   * and an onWidgetBeforeDOMChange and onWidgetAfterDOMChange notification
   * for each window CustomizableUI knows about.
   *
   * @param aWidgetId the ID of the widget to add
   * @param aArea     the ID of the area to add the widget to
   * @param aPosition the position at which to add the widget. If you do not
   *                  pass a position, the widget will be added to the end
   *                  of the area.
   */
  addWidgetToArea(aWidgetId, aArea, aPosition) {
    CustomizableUIInternal.addWidgetToArea(aWidgetId, aArea, aPosition);
  },
  /**
   * Remove a widget from its area. If the widget cannot be removed from its
   * area, or is not in any area, this will no-op. Otherwise, this will fire an
   * onWidgetRemoved notification, and an onWidgetBeforeDOMChange and
   * onWidgetAfterDOMChange notification for each window CustomizableUI knows
   * about.
   *
   * @param aWidgetId the ID of the widget to remove
   */
  removeWidgetFromArea(aWidgetId) {
    CustomizableUIInternal.removeWidgetFromArea(aWidgetId);
  },
  /**
   * Move a widget within an area.
   * If the widget is not in any area, this will no-op.
   * If the widget is already at the indicated position, this will no-op.
   *
   * Otherwise, this will move the widget and fire an onWidgetMoved notification,
   * and an onWidgetBeforeDOMChange and onWidgetAfterDOMChange notification for
   * each window CustomizableUI knows about.
   *
   * @param aWidgetId the ID of the widget to move
   * @param aPosition the position to move the widget to.
   *                  Negative values or values greater than the number of
   *                  widgets will be interpreted to mean moving the widget to
   *                  respectively the first or last position.
   */
  moveWidgetWithinArea(aWidgetId, aPosition) {
    CustomizableUIInternal.moveWidgetWithinArea(aWidgetId, aPosition);
  },
  /**
   * Ensure a XUL-based widget created in a window after areas were
   * initialized moves to its correct position.
   * Always prefer this over moving items in the DOM yourself.
   *
   * @param aWidgetId the ID of the widget that was just created
   * @param aWindow the window in which you want to ensure it was added.
   *
   * NB: why is this API per-window, you wonder? Because if you need this,
   * presumably you yourself need to create the widget in all the windows
   * and need to loop through them anyway.
   */
  ensureWidgetPlacedInWindow(aWidgetId, aWindow) {
    return CustomizableUIInternal.ensureWidgetPlacedInWindow(
      aWidgetId,
      aWindow
    );
  },
  /**
   * Start a batch update of items.
   * During a batch update, the customization state is not saved to the user's
   * preferences file, in order to reduce (possibly sync) IO.
   * Calls to begin/endBatchUpdate may be nested.
   *
   * Callers should ensure that NO MATTER WHAT they call endBatchUpdate once
   * for each call to beginBatchUpdate, even if there are exceptions in the
   * code in the batch update. Otherwise, for the duration of the
   * Firefox session, customization state is never saved. Typically, you
   * would do this using a try...finally block.
   */
  beginBatchUpdate() {
    CustomizableUIInternal.beginBatchUpdate();
  },
  /**
   * End a batch update. See the documentation for beginBatchUpdate above.
   *
   * State is not saved if we believe it is identical to the last known
   * saved state. State is only ever saved when all batch updates have
   * finished (ie there has been 1 endBatchUpdate call for each
   * beginBatchUpdate call). If any of the endBatchUpdate calls pass
   * aForceDirty=true, we will flush to the prefs file.
   *
   * @param aForceDirty force CustomizableUI to flush to the prefs file when
   *                    all batch updates have finished.
   */
  endBatchUpdate(aForceDirty) {
    CustomizableUIInternal.endBatchUpdate(aForceDirty);
  },
  /**
   * Create a widget.
   *
   * To create a widget, you should pass an object with its desired
   * properties. The following properties are supported:
   *
   * - id:            the ID of the widget (required).
   * - type:          a string indicating the type of widget. Possible types
   *                  are:
   *                  'button' - for simple button widgets (the default)
   *                  'view'   - for buttons that open a panel or subview,
   *                             depending on where they are placed.
   *                  'button-and-view' - A combination of 'button' and 'view',
   *                             which looks different depending on whether it's
   *                             located in the toolbar or in the panel: When
   *                             located in the toolbar, the widget is shown as
   *                             a combined item of a button and a dropmarker
   *                             button. The button triggers the command and the
   *                             dropmarker button opens the view. When located
   *                             in the panel, shown as one item which opens the
   *                             view, and the button command cannot be
   *                             triggered separately.
   *                  'custom' - for fine-grained control over the creation
   *                             of the widget.
   * - viewId:        Only useful for views and button-and-view widgets (and
   *                  required there): the id of the <panelview> that should be
   *                  shown when clicking the widget.  If used with a custom
   *                  widget, the widget must also provide a toolbaritem where
   *                  the first child is the view button.
   * - onBuild(aDoc): Only useful for custom widgets (and required there); a
   *                  function that will be invoked with the document in which
   *                  to build a widget. Should return the DOM node that has
   *                  been constructed.
   * - onBeforeCreated(aDoc): Attached to all non-custom widgets; a function
   *                  that will be invoked before the widget gets a DOM node
   *                  constructed, passing the document in which that will happen.
   *                  This is useful especially for 'view' type widgets that need
   *                  to construct their views on the fly (e.g. from bootstrapped
   *                  add-ons). If the function returns `false`, the widget will
   *                  not be created.
   * - onCreated(aNode): Attached to all widgets; a function that will be invoked
   *                  whenever the widget has a DOM node constructed, passing the
   *                  constructed node as an argument.
   * - onDestroyed(aDoc): Attached to all non-custom widgets; a function that
   *                  will be invoked after the widget has a DOM node destroyed,
   *                  passing the document from which it was removed. This is
   *                  useful especially for 'view' type widgets that need to
   *                  cleanup after views that were constructed on the fly.
   * - onBeforeCommand(aEvt, aNode): A function that will be invoked when the user
   *                          activates the button but before the command
   *                          is evaluated. Useful if code needs to run to
   *                          change the button's icon in preparation to the
   *                          pending command action. Called for any type that
   *                          supports the handler.  The command type, either
   *                          "view" or "command", may be returned to force the
   *                          action that will occur.  View will open the panel
   *                          and command will result in calling onCommand.
   * - onCommand(aEvt): Useful for custom, button and button-and-view widgets; a
   *                    function that will be invoked when the user activates
   *                    the button. A custom widget with a view should
   *                    return "view" or "command" to continue processing
   *                    the command per the needs of the widget.
   * - onClick(aEvt): Attached to all widgets; a function that will be invoked
   *                  when the user clicks the widget.
   * - onViewShowing(aEvt): Only useful for views and button-and-view widgets; a
   *                  function that will be invoked when a user shows your view.
   *                  If any event handler calls aEvt.preventDefault(), the view
   *                  will not be shown.
   *
   *                  The event's `detail` property is an object with an
   *                  `addBlocker` method. Handlers which need to
   *                  perform asynchronous operations before the view is
   *                  shown may pass this method a Promise, which will
   *                  prevent the view from showing until it resolves.
   *                  Additionally, if the promise resolves to the exact
   *                  value `false`, the view will not be shown.
   * - onViewHiding(aEvt): Only useful for views; a function that will be
   *                  invoked when a user hides your view.
   * - l10nId:        fluent string identifier to use for localizing attributes
   *                  on the widget. If present, preferred over the
   *                  label/tooltiptext.
   * - tooltiptext:   string to use for the tooltip of the widget
   * - label:         string to use for the label of the widget
   * - localized:     If true, or undefined, attempt to retrieve the
   *                  widget's string properties from the customizable
   *                  widgets string bundle.
   * - removable:     whether the widget is removable (optional, default: true)
   *                  NB: if you specify false here, you must provide a
   *                  defaultArea, too.
   * - overflows:     whether widget can overflow when in an overflowable
   *                  toolbar (optional, default: true)
   * - defaultArea:   default area to add the widget to
   *                  (optional, default: none; required if non-removable)
   * - shortcutId:    id of an element that has a shortcut for this widget
   *                  (optional, default: null). This is only used to display
   *                  the shortcut as part of the tooltip for builtin widgets
   *                  (which have strings inside
   *                  customizableWidgets.properties). If you're in an add-on,
   *                  you should not set this property.
   *                  If l10nId is provided, the resulting shortcut is passed
   *                  as the "$shortcut" variable to the fluent message.
   * - showInPrivateBrowsing: whether to show the widget in private browsing
   *                          mode (optional, default: true)
   * - tabSpecific:      If true, closes the panel if the tab changes.
   * - locationSpecific: If true, closes the panel if the location changes.
   *                     This is similar to tabSpecific, but also if the location
   *                     changes in the same tab, we may want to close the panel.
   * - webExtension:  Set to true if this widget is being created on behalf of an
   *                  extension.
   *
   * @param aProperties the specifications for the widget.
   * @return a wrapper around the created widget (see getWidget)
   */
  createWidget(aProperties) {
    return CustomizableUIInternal.wrapWidget(
      CustomizableUIInternal.createWidget(aProperties)
    );
  },
  /**
   * Destroy a widget
   *
   * If the widget is part of the default placements in an area, this will
   * remove it from there. It will also remove any DOM instances. However,
   * it will keep the widget in the placements for whatever area it was
   * in at the time. You can remove it from there yourself by calling
   * CustomizableUI.removeWidgetFromArea(aWidgetId).
   *
   * @param aWidgetId the ID of the widget to destroy
   */
  destroyWidget(aWidgetId) {
    CustomizableUIInternal.destroyWidget(aWidgetId);
  },
  /**
   * Get a wrapper object with information about the widget.
   * The object provides the following properties
   * (all read-only unless otherwise indicated):
   *
   * - id:            the widget's ID;
   * - type:          the type of widget (button, view, custom). For
   *                  XUL-provided widgets, this is always 'custom';
   * - provider:      the provider type of the widget, id est one of
   *                  PROVIDER_API or PROVIDER_XUL;
   * - forWindow(w):  a method to obtain a single window wrapper for a widget,
   *                  in the window w passed as the only argument;
   * - instances:     an array of all instances (single window wrappers)
   *                  of the widget. This array is NOT live;
   * - areaType:      the type of the widget's current area
   * - isGroup:       true; will be false for wrappers around single widget nodes;
   * - source:        for API-provided widgets, whether they are built-in to
   *                  Firefox or add-on-provided;
   * - disabled:      for API-provided widgets, whether the widget is currently
   *                  disabled. NB: this property is writable, and will toggle
   *                  all the widgets' nodes' disabled states;
   * - label:         for API-provied widgets, the label of the widget;
   * - tooltiptext:   for API-provided widgets, the tooltip of the widget;
   * - showInPrivateBrowsing: for API-provided widgets, whether the widget is
   *                          visible in private browsing;
   *
   * Single window wrappers obtained through forWindow(someWindow) or from the
   * instances array have the following properties
   * (all read-only unless otherwise indicated):
   *
   * - id:            the widget's ID;
   * - type:          the type of widget (button, view, custom). For
   *                  XUL-provided widgets, this is always 'custom';
   * - provider:      the provider type of the widget, id est one of
   *                  PROVIDER_API or PROVIDER_XUL;
   * - node:          reference to the corresponding DOM node;
   * - anchor:        the anchor on which to anchor panels opened from this
   *                  node. This will point to the overflow chevron on
   *                  overflowable toolbars if and only if your widget node
   *                  is overflowed, to the anchor for the panel menu
   *                  if your widget is inside the panel menu, and to the
   *                  node itself in all other cases;
   * - overflowed:    boolean indicating whether the node is currently in the
   *                  overflow panel of the toolbar;
   * - isGroup:       false; will be true for the group widget;
   * - label:         for API-provided widgets, convenience getter for the
   *                  label attribute of the DOM node;
   * - tooltiptext:   for API-provided widgets, convenience getter for the
   *                  tooltiptext attribute of the DOM node;
   * - disabled:      for API-provided widgets, convenience getter *and setter*
   *                  for the disabled state of this single widget. Note that
   *                  you may prefer to use the group wrapper's getter/setter
   *                  instead.
   *
   * @param aWidgetId the ID of the widget whose information you need
   * @return a wrapper around the widget as described above, or null if the
   *         widget is known not to exist (anymore). NB: non-null return
   *         is no guarantee the widget exists because we cannot know in
   *         advance if a XUL widget exists or not.
   */
  getWidget(aWidgetId) {
    return CustomizableUIInternal.wrapWidget(aWidgetId);
  },
  /**
   * Get an array of widget wrappers (see getWidget) for all the widgets
   * which are currently not in any area (so which are in the palette).
   *
   * @param aWindowPalette the palette (and by extension, the window) in which
   *                       CustomizableUI should look. This matters because of
   *                       course XUL-provided widgets could be available in
   *                       some windows but not others, and likewise
   *                       API-provided widgets might not exist in a private
   *                       window (because of the showInPrivateBrowsing
   *                       property).
   *
   * @return an array of widget wrappers (see getWidget)
   */
  getUnusedWidgets(aWindowPalette) {
    return CustomizableUIInternal.getUnusedWidgets(aWindowPalette).map(
      CustomizableUIInternal.wrapWidget,
      CustomizableUIInternal
    );
  },
  /**
   * Get an array of all the widget IDs placed in an area.
   * Modifying the array will not affect CustomizableUI.
   *
   * @param aArea the ID of the area whose placements you want to obtain.
   * @return an array containing the widget IDs that are in the area.
   *
   * NB: will throw if called too early (before placements have been fetched)
   *     or if the area is not currently known to CustomizableUI.
   */
  getWidgetIdsInArea(aArea) {
    if (!gAreas.has(aArea)) {
      throw new Error("Unknown customization area: " + aArea);
    }
    if (!gPlacements.has(aArea)) {
      throw new Error("Area not yet restored");
    }

    // We need to clone this, as we don't want to let consumers muck with placements
    return [...gPlacements.get(aArea)];
  },
  /**
   * Get an array of widget wrappers for all the widgets in an area. This is
   * the same as calling getWidgetIdsInArea and .map() ing the result through
   * CustomizableUI.getWidget. Careful: this means that if there are IDs in there
   * which don't have corresponding DOM nodes, there might be nulls in this array,
   * or items for which wrapper.forWindow(win) will return null.
   *
   * @param aArea the ID of the area whose widgets you want to obtain.
   * @return an array of widget wrappers and/or null values for the widget IDs
   *         placed in an area.
   *
   * NB: will throw if called too early (before placements have been fetched)
   *     or if the area is not currently known to CustomizableUI.
   */
  getWidgetsInArea(aArea) {
    return this.getWidgetIdsInArea(aArea).map(
      CustomizableUIInternal.wrapWidget,
      CustomizableUIInternal
    );
  },

  /**
   * Ensure the customizable widget that matches up with this view node
   * will get the right subview showing/shown/hiding/hidden events when
   * they fire.
   * @param aViewNode the view node to add listeners to if they haven't
   *                  been added already.
   */
  ensureSubviewListeners(aViewNode) {
    return CustomizableUIInternal.ensureSubviewListeners(aViewNode);
  },
  /**
   * Obtain an array of all the area IDs known to CustomizableUI.
   * This array is created for you, so is modifiable without CustomizableUI
   * being affected.
   */
  get areas() {
    return [...gAreas.keys()];
  },
  /**
   * Check what kind of area (toolbar or menu panel) an area is. This is
   * useful if you have a widget that needs to behave differently depending
   * on its location. Note that widget wrappers have a convenience getter
   * property (areaType) for this purpose.
   *
   * @param aArea the ID of the area whose type you want to know
   * @return TYPE_TOOLBAR or TYPE_PANEL depending on the area, null if
   *         the area is unknown.
   */
  getAreaType(aArea) {
    let area = gAreas.get(aArea);
    return area ? area.get("type") : null;
  },
  /**
   * Check if a toolbar is collapsed by default.
   *
   * @param aArea the ID of the area whose default-collapsed state you want to know.
   * @return `true` or `false` depending on the area, null if the area is unknown,
   *         or its collapsed state cannot normally be controlled by the user
   */
  isToolbarDefaultCollapsed(aArea) {
    let area = gAreas.get(aArea);
    return area ? area.get("defaultCollapsed") : null;
  },
  /**
   * Obtain the DOM node that is the customize target for an area in a
   * specific window.
   *
   * Areas can have a customization target that does not correspond to the
   * node itself. In particular, toolbars that have a customizationtarget
   * attribute set will have their customization target set to that node.
   * This means widgets will end up in the customization target, not in the
   * DOM node with the ID that corresponds to the area ID. This is useful
   * because it lets you have fixed content in a toolbar (e.g. the panel
   * menu item in the navbar) and have all the customizable widgets use
   * the customization target.
   *
   * Using this API yourself is discouraged; you should generally not need
   * to be asking for the DOM container node used for a particular area.
   * In particular, if you're wanting to check it in relation to a widget's
   * node, your DOM node might not be a direct child of the customize target
   * in a window if, for instance, the window is in customization mode, or if
   * this is an overflowable toolbar and the widget has been overflowed.
   *
   * @param aArea   the ID of the area whose customize target you want to have
   * @param aWindow the window where you want to fetch the DOM node.
   * @return the customize target DOM node for aArea in aWindow
   */
  getCustomizeTargetForArea(aArea, aWindow) {
    return CustomizableUIInternal.getCustomizeTargetForArea(aArea, aWindow);
  },
  /**
   * Reset the customization state back to its default.
   *
   * This is the nuclear option. You should never call this except if the user
   * explicitly requests it. Firefox does this when the user clicks the
   * "Restore Defaults" button in customize mode.
   */
  reset() {
    CustomizableUIInternal.reset();
  },

  /**
   * Undo the previous reset, can only be called immediately after a reset.
   * @return a promise that will be resolved when the operation is complete.
   */
  undoReset() {
    CustomizableUIInternal.undoReset();
  },

  /**
   * Remove a custom toolbar added in a previous version of Firefox or using
   * an add-on. NB: only works on the customizable toolbars generated by
   * the toolbox itself. Intended for use from CustomizeMode, not by
   * other consumers.
   * @param aToolbarId the ID of the toolbar to remove
   */
  removeExtraToolbar(aToolbarId) {
    CustomizableUIInternal.removeExtraToolbar(aToolbarId);
  },

  /**
   * Can the last Restore Defaults operation be undone.
   *
   * @return A boolean stating whether an undo of the
   *         Restore Defaults can be performed.
   */
  get canUndoReset() {
    return (
      gUIStateBeforeReset.uiCustomizationState != null ||
      gUIStateBeforeReset.drawInTitlebar != null ||
      gUIStateBeforeReset.currentTheme != null ||
      gUIStateBeforeReset.autoTouchMode != null ||
      gUIStateBeforeReset.uiDensity != null
    );
  },

  /**
   * Get the placement of a widget. This is by far the best way to obtain
   * information about what the state of your widget is. The internals of
   * this call are cheap (no DOM necessary) and you will know where the user
   * has put your widget.
   *
   * @param aWidgetId the ID of the widget whose placement you want to know
   * @return
   *   {
   *     area: "somearea", // The ID of the area where the widget is placed
   *     position: 42 // the index in the placements array corresponding to
   *                  // your widget.
   *   }
   *
   *   OR
   *
   *   null // if the widget is not placed anywhere (ie in the palette)
   */
  getPlacementOfWidget(aWidgetId, aOnlyRegistered = true, aDeadAreas = false) {
    return CustomizableUIInternal.getPlacementOfWidget(
      aWidgetId,
      aOnlyRegistered,
      aDeadAreas
    );
  },
  /**
   * Check if a widget can be removed from the area it's in.
   *
   * Note that if you're wanting to move the widget somewhere, you should
   * generally be checking canWidgetMoveToArea, because that will return
   * true if the widget is already in the area where you want to move it (!).
   *
   * NB: oh, also, this method might lie if the widget in question is a
   *     XUL-provided widget and there are no windows open, because it
   *     can obviously not check anything in this case. It will return
   *     true. You will be able to move the widget elsewhere. However,
   *     once the user reopens a window, the widget will move back to its
   *     'proper' area automagically.
   *
   * @param aWidgetId a widget ID or DOM node to check
   * @return true if the widget can be removed from its area,
   *          false otherwise.
   */
  isWidgetRemovable(aWidgetId) {
    return CustomizableUIInternal.isWidgetRemovable(aWidgetId);
  },
  /**
   * Check if a widget can be moved to a particular area. Like
   * isWidgetRemovable but better, because it'll return true if the widget
   * is already in the right area.
   *
   * @param aWidgetId the widget ID or DOM node you want to move somewhere
   * @param aArea     the area ID you want to move it to. This can also be
   *                  AREA_NO_AREA to see if the widget can move to the
   *                  customization palette, whether it's removable or not.
   * @return true if this is possible, false if it is not. The same caveats as
   *              for isWidgetRemovable apply, however, if no windows are open.
   */
  canWidgetMoveToArea(aWidgetId, aArea) {
    return CustomizableUIInternal.canWidgetMoveToArea(aWidgetId, aArea);
  },
  /**
   * Whether we're in a default state. Note that non-removable non-default
   * widgets and non-existing widgets are not taken into account in determining
   * whether we're in the default state.
   *
   * NB: this is a property with a getter. The getter is NOT cheap, because
   * it does smart things with non-removable non-default items, non-existent
   * items, and so forth. Please don't call unless necessary.
   */
  get inDefaultState() {
    return CustomizableUIInternal.inDefaultState;
  },

  /**
   * Set a toolbar's visibility state in all windows.
   * @param aToolbarId    the toolbar whose visibility should be adjusted
   * @param aIsVisible    whether the toolbar should be visible
   */
  setToolbarVisibility(aToolbarId, aIsVisible) {
    CustomizableUIInternal.setToolbarVisibility(aToolbarId, aIsVisible);
  },

  /**
   * Returns a Set with the IDs of any registered toolbar areas that are
   * currently collapsed in a particular window. Menubars that are set to
   * autohide and are in the temporary "open" state are still considered
   * collapsed by default.
   *
   * @param {Window} window The browser window to check for collapsed toolbars.
   * @return {Set<string>}
   */
  getCollapsedToolbarIds(window) {
    return CustomizableUIInternal.getCollapsedToolbarIds(window);
  },

  /**
   * DEPRECATED! Use fluent instead.
   *
   * Get a localized property off a (widget?) object.
   *
   * NB: this is unlikely to be useful unless you're in Firefox code, because
   *     this code uses the builtin widget stringbundle, and can't be told
   *     to use add-on-provided strings. It's mainly here as convenience for
   *     custom builtin widgets that build their own DOM but use the same
   *     stringbundle as the other builtin widgets.
   *
   * @param aWidget     the object whose property we should use to fetch a
   *                    localizable string;
   * @param aProp       the property on the object to use for the fetching;
   * @param aFormatArgs (optional) any extra arguments to use for a formatted
   *                    string;
   * @param aDef        (optional) the default to return if we don't find the
   *                    string in the stringbundle;
   *
   * @return the localized string, or aDef if the string isn't in the bundle.
   *         If no default is provided,
   *           if aProp exists on aWidget, we'll return that,
   *           otherwise we'll return the empty string
   *
   */
  getLocalizedProperty(aWidget, aProp, aFormatArgs, aDef) {
    return CustomizableUIInternal.getLocalizedProperty(
      aWidget,
      aProp,
      aFormatArgs,
      aDef
    );
  },
  /**
   * Utility function to detect, find and set a keyboard shortcut for a menuitem
   * or (toolbar)button.
   *
   * @param aShortcutNode the XUL node where the shortcut will be derived from;
   * @param aTargetNode   (optional) the XUL node on which the `shortcut`
   *                      attribute will be set. If NULL, the shortcut will be
   *                      set on aShortcutNode;
   */
  addShortcut(aShortcutNode, aTargetNode) {
    return CustomizableUIInternal.addShortcut(aShortcutNode, aTargetNode);
  },
  /**
   * Given a node, walk up to the first panel in its ancestor chain, and
   * close it.
   *
   * @param aNode a node whose panel should be closed;
   */
  hidePanelForNode(aNode) {
    CustomizableUIInternal.hidePanelForNode(aNode);
  },
  /**
   * Check if a widget is a "special" widget: a spring, spacer or separator.
   *
   * @param aWidgetId the widget ID to check.
   * @return true if the widget is 'special', false otherwise.
   */
  isSpecialWidget(aWidgetId) {
    return CustomizableUIInternal.isSpecialWidget(aWidgetId);
  },
  /**
   * Check if a widget is provided by an extension. This effectively checks
   * whether `webExtension: true` passed when the widget was being created.
   *
   * If the widget being referred to hasn't yet been created, or has been
   * destroyed, we fallback to checking the ID for the "-browser-action"
   * suffix.
   *
   * @param aWidgetId the widget ID to check.
   * @return true if the widget was provided by an extension, false otherwise.
   */
  isWebExtensionWidget(aWidgetId) {
    let widget = CustomizableUI.getWidget(aWidgetId);
    return widget?.webExtension || aWidgetId.endsWith("-browser-action");
  },
  /**
   * Add listeners to a panel that will close it. For use from the menu panel
   * and overflowable toolbar implementations, unlikely to be useful for
   * consumers.
   *
   * @param aPanel the panel to which listeners should be attached.
   */
  addPanelCloseListeners(aPanel) {
    CustomizableUIInternal.addPanelCloseListeners(aPanel);
  },
  /**
   * Remove close listeners that have been added to a panel with
   * addPanelCloseListeners. For use from the menu panel and overflowable
   * toolbar implementations, unlikely to be useful for consumers.
   *
   * @param aPanel the panel from which listeners should be removed.
   */
  removePanelCloseListeners(aPanel) {
    CustomizableUIInternal.removePanelCloseListeners(aPanel);
  },
  /**
   * Notify listeners a widget is about to be dragged to an area. For use from
   * Customize Mode only, do not use otherwise.
   *
   * @param aWidgetId the ID of the widget that is being dragged to an area.
   * @param aArea     the ID of the area to which the widget is being dragged.
   */
  onWidgetDrag(aWidgetId, aArea) {
    CustomizableUIInternal.notifyListeners("onWidgetDrag", aWidgetId, aArea);
  },
  /**
   * Notify listeners that a window is entering customize mode. For use from
   * Customize Mode only, do not use otherwise.
   * @param aWindow the window entering customize mode
   */
  notifyStartCustomizing(aWindow) {
    CustomizableUIInternal.notifyListeners("onCustomizeStart", aWindow);
  },
  /**
   * Notify listeners that a window is exiting customize mode. For use from
   * Customize Mode only, do not use otherwise.
   * @param aWindow the window exiting customize mode
   */
  notifyEndCustomizing(aWindow) {
    CustomizableUIInternal.notifyListeners("onCustomizeEnd", aWindow);
  },

  /**
   * Notify toolbox(es) of a particular event. If you don't pass aWindow,
   * all toolboxes will be notified. For use from Customize Mode only,
   * do not use otherwise.
   * @param aEvent the name of the event to send.
   * @param aDetails optional, the details of the event.
   * @param aWindow optional, the window in which to send the event.
   */
  dispatchToolboxEvent(aEvent, aDetails = {}, aWindow = null) {
    CustomizableUIInternal.dispatchToolboxEvent(aEvent, aDetails, aWindow);
  },

  /**
   * Check whether an area is overflowable.
   *
   * @param aAreaId the ID of an area to check for overflowable-ness
   * @return true if the area is overflowable, false otherwise.
   */
  isAreaOverflowable(aAreaId) {
    let area = gAreas.get(aAreaId);
    return area
      ? area.get("type") == this.TYPE_TOOLBAR && area.get("overflowable")
      : false;
  },
  /**
   * Obtain a string indicating the place of an element. This is intended
   * for use from customize mode; You should generally use getPlacementOfWidget
   * instead, which is cheaper because it does not use the DOM.
   *
   * @param aElement the DOM node whose place we need to check
   * @return "toolbar" if the node is in a toolbar, "panel" if it is in the
   *         menu panel, "palette" if it is in the (visible!) customization
   *         palette, undefined otherwise.
   */
  getPlaceForItem(aElement) {
    let place;
    let node = aElement;
    while (node && !place) {
      if (node.localName == "toolbar") {
        place = "toolbar";
      } else if (node.id == CustomizableUI.AREA_FIXED_OVERFLOW_PANEL) {
        place = "panel";
      } else if (node.id == "customization-palette") {
        place = "palette";
      }

      node = node.parentNode;
    }
    return place;
  },

  /**
   * Check if a toolbar is builtin or not.
   * @param aToolbarId the ID of the toolbar you want to check
   */
  isBuiltinToolbar(aToolbarId) {
    return CustomizableUIInternal._builtinToolbars.has(aToolbarId);
  },

  /**
   * Create an instance of a spring, spacer or separator.
   * @param aId       the type of special widget (spring, spacer or separator)
   * @param aDocument the document in which to create it.
   */
  createSpecialWidget(aId, aDocument) {
    return CustomizableUIInternal.createSpecialWidget(aId, aDocument);
  },

  /**
   * Fills a submenu with menu items.
   * @param aMenuItems the menu items to display.
   * @param aSubview   the subview to fill.
   */
  fillSubviewFromMenuItems(aMenuItems, aSubview) {
    let attrs = [
      "oncommand",
      "onclick",
      "label",
      "key",
      "disabled",
      "command",
      "observes",
      "hidden",
      "class",
      "origin",
      "image",
      "checked",
      "style",
    ];

    // Use ownerGlobal.document to ensure we get the right doc even for
    // elements in template tags.
    let doc = aSubview.ownerGlobal.document;
    let fragment = doc.createDocumentFragment();
    for (let menuChild of aMenuItems) {
      if (menuChild.hidden) {
        continue;
      }

      let subviewItem;
      if (menuChild.localName == "menuseparator") {
        // Don't insert duplicate or leading separators. This can happen if there are
        // menus (which we don't copy) above the separator.
        if (
          !fragment.lastElementChild ||
          fragment.lastElementChild.localName == "toolbarseparator"
        ) {
          continue;
        }
        subviewItem = doc.createXULElement("toolbarseparator");
      } else if (menuChild.localName == "menuitem") {
        subviewItem = doc.createXULElement("toolbarbutton");
        CustomizableUI.addShortcut(menuChild, subviewItem);

        let item = menuChild;
        if (!item.hasAttribute("onclick")) {
          subviewItem.addEventListener("click", event => {
            let newEvent = new doc.defaultView.MouseEvent(event.type, event);

            // Telemetry should only pay attention to the original event.
            lazy.BrowserUsageTelemetry.ignoreEvent(newEvent);
            item.dispatchEvent(newEvent);
          });
        }

        if (!item.hasAttribute("oncommand")) {
          subviewItem.addEventListener("command", event => {
            let newEvent = doc.createEvent("XULCommandEvent");
            newEvent.initCommandEvent(
              event.type,
              event.bubbles,
              event.cancelable,
              event.view,
              event.detail,
              event.ctrlKey,
              event.altKey,
              event.shiftKey,
              event.metaKey,
              0,
              event.sourceEvent,
              0
            );

            // Telemetry should only pay attention to the original event.
            lazy.BrowserUsageTelemetry.ignoreEvent(newEvent);
            item.dispatchEvent(newEvent);
          });
        }
      } else {
        continue;
      }
      for (let attr of attrs) {
        let attrVal = menuChild.getAttribute(attr);
        if (attrVal) {
          subviewItem.setAttribute(attr, attrVal);
        }
      }
      // We do this after so the .subviewbutton class doesn't get overriden.
      if (menuChild.localName == "menuitem") {
        subviewItem.classList.add("subviewbutton");
      }

      // We make it possible to supply an alternative Fluent key when cloning
      // this menuitem into the AppMenu or panel contexts. This is because
      // we often use Title Case in menuitems in native menus, but want to use
      // Sentence case in the AppMenu / panels.
      let l10nId = menuChild.getAttribute("appmenu-data-l10n-id");
      if (l10nId) {
        doc.l10n.setAttributes(subviewItem, l10nId);
      }

      fragment.appendChild(subviewItem);
    }
    aSubview.appendChild(fragment);
  },

  /**
   * A helper function for clearing subviews.
   * @param aSubview the subview to clear.
   */
  clearSubview(aSubview) {
    let parent = aSubview.parentNode;
    // We'll take the container out of the document before cleaning it out
    // to avoid reflowing each time we remove something.
    parent.removeChild(aSubview);

    while (aSubview.firstChild) {
      aSubview.firstChild.remove();
    }

    parent.appendChild(aSubview);
  },

  getCustomizationTarget(aElement) {
    return CustomizableUIInternal.getCustomizationTarget(aElement);
  },

  getTestOnlyInternalProp(aProp) {
    if (!Cu.isInAutomation) {
      return null;
    }
    switch (aProp) {
      case "CustomizableUIInternal":
        return CustomizableUIInternal;
      case "gAreas":
        return gAreas;
      case "gFuturePlacements":
        return gFuturePlacements;
      case "gPalette":
        return gPalette;
      case "gPlacements":
        return gPlacements;
      case "gSavedState":
        return gSavedState;
      case "gSeenWidgets":
        return gSeenWidgets;
      case "kVersion":
        return kVersion;
    }
    return null;
  },
  setTestOnlyInternalProp(aProp, aValue) {
    if (!Cu.isInAutomation) {
      return;
    }
    switch (aProp) {
      case "gSavedState":
        gSavedState = aValue;
        break;
      case "kVersion":
        kVersion = aValue;
        break;
      case "gDirty":
        gDirty = aValue;
        break;
    }
  },
};

Object.freeze(CustomizableUI);
Object.freeze(CustomizableUI.windows);

/**
 * All external consumers of widgets are really interacting with these wrappers
 * which provide a common interface.
 */

/**
 * WidgetGroupWrapper is the common interface for interacting with an entire
 * widget group - AKA, all instances of a widget across a series of windows.
 * This particular wrapper is only used for widgets created via the provider
 * API.
 */
function WidgetGroupWrapper(aWidget) {
  this.isGroup = true;

  const kBareProps = [
    "id",
    "source",
    "type",
    "disabled",
    "label",
    "tooltiptext",
    "showInPrivateBrowsing",
    "viewId",
    "disallowSubView",
    "webExtension",
  ];
  for (let prop of kBareProps) {
    let propertyName = prop;
    this.__defineGetter__(propertyName, () => aWidget[propertyName]);
  }

  this.__defineGetter__("provider", () => CustomizableUI.PROVIDER_API);

  this.__defineSetter__("disabled", function (aValue) {
    aValue = !!aValue;
    aWidget.disabled = aValue;
    for (let [, instance] of aWidget.instances) {
      instance.disabled = aValue;
    }
  });

  this.forWindow = function WidgetGroupWrapper_forWindow(aWindow) {
    let wrapperMap;
    if (!gSingleWrapperCache.has(aWindow)) {
      wrapperMap = new Map();
      gSingleWrapperCache.set(aWindow, wrapperMap);
    } else {
      wrapperMap = gSingleWrapperCache.get(aWindow);
    }
    if (wrapperMap.has(aWidget.id)) {
      return wrapperMap.get(aWidget.id);
    }

    let instance = aWidget.instances.get(aWindow.document);
    if (!instance) {
      instance = CustomizableUIInternal.buildWidget(aWindow.document, aWidget);
    }

    let wrapper = new WidgetSingleWrapper(aWidget, instance);
    wrapperMap.set(aWidget.id, wrapper);
    return wrapper;
  };

  this.__defineGetter__("instances", function () {
    // Can't use gBuildWindows here because some areas load lazily:
    let placement = CustomizableUIInternal.getPlacementOfWidget(aWidget.id);
    if (!placement) {
      return [];
    }
    let area = placement.area;
    let buildAreas = gBuildAreas.get(area);
    if (!buildAreas) {
      return [];
    }
    return Array.from(buildAreas, node => this.forWindow(node.ownerGlobal));
  });

  this.__defineGetter__("areaType", function () {
    let areaProps = gAreas.get(aWidget.currentArea);
    return areaProps && areaProps.get("type");
  });

  Object.freeze(this);
}

/**
 * A WidgetSingleWrapper is a wrapper around a single instance of a widget in
 * a particular window.
 */
function WidgetSingleWrapper(aWidget, aNode) {
  this.isGroup = false;

  this.node = aNode;
  this.provider = CustomizableUI.PROVIDER_API;

  const kGlobalProps = ["id", "type"];
  for (let prop of kGlobalProps) {
    this[prop] = aWidget[prop];
  }

  const kNodeProps = ["label", "tooltiptext"];
  for (let prop of kNodeProps) {
    let propertyName = prop;
    // Look at the node for these, instead of the widget data, to ensure the
    // wrapper always reflects this live instance.
    this.__defineGetter__(propertyName, () => aNode.getAttribute(propertyName));
  }

  this.__defineGetter__("disabled", () => aNode.disabled);
  this.__defineSetter__("disabled", function (aValue) {
    aNode.disabled = !!aValue;
  });

  this.__defineGetter__("anchor", function () {
    let anchorId;
    // First check for an anchor for the area:
    let placement = CustomizableUIInternal.getPlacementOfWidget(aWidget.id);
    if (placement) {
      anchorId = gAreas.get(placement.area).get("anchor");
    }
    if (!anchorId) {
      anchorId = aNode.getAttribute("cui-anchorid");
    }
    if (!anchorId) {
      anchorId = aNode.getAttribute("view-button-id");
    }
    if (anchorId) {
      return aNode.ownerDocument.getElementById(anchorId);
    }
    if (aWidget.type == "button-and-view") {
      return aNode.lastElementChild;
    }
    return aNode;
  });

  this.__defineGetter__("overflowed", function () {
    return aNode.getAttribute("overflowedItem") == "true";
  });

  Object.freeze(this);
}

/**
 * XULWidgetGroupWrapper is the common interface for interacting with an entire
 * widget group - AKA, all instances of a widget across a series of windows.
 * This particular wrapper is only used for widgets created via the old-school
 * XUL method (overlays, or programmatically injecting toolbaritems, or other
 * such things).
 */
// XXXunf Going to need to hook this up to some events to keep it all live.
function XULWidgetGroupWrapper(aWidgetId) {
  this.isGroup = true;
  this.id = aWidgetId;
  this.type = "custom";
  // XUL Widgets can never be provided by extensions.
  this.webExtension = false;
  this.provider = CustomizableUI.PROVIDER_XUL;

  this.forWindow = function XULWidgetGroupWrapper_forWindow(aWindow) {
    let wrapperMap;
    if (!gSingleWrapperCache.has(aWindow)) {
      wrapperMap = new Map();
      gSingleWrapperCache.set(aWindow, wrapperMap);
    } else {
      wrapperMap = gSingleWrapperCache.get(aWindow);
    }
    if (wrapperMap.has(aWidgetId)) {
      return wrapperMap.get(aWidgetId);
    }

    let instance = aWindow.document.getElementById(aWidgetId);
    if (!instance) {
      // Toolbar palettes aren't part of the document, so elements in there
      // won't be found via document.getElementById().
      instance = aWindow.gNavToolbox.palette.getElementsByAttribute(
        "id",
        aWidgetId
      )[0];
    }

    let wrapper = new XULWidgetSingleWrapper(
      aWidgetId,
      instance,
      aWindow.document
    );
    wrapperMap.set(aWidgetId, wrapper);
    return wrapper;
  };

  this.__defineGetter__("areaType", function () {
    let placement = CustomizableUIInternal.getPlacementOfWidget(aWidgetId);
    if (!placement) {
      return null;
    }

    let areaProps = gAreas.get(placement.area);
    return areaProps && areaProps.get("type");
  });

  this.__defineGetter__("instances", function () {
    return Array.from(gBuildWindows, wins => this.forWindow(wins[0]));
  });

  Object.freeze(this);
}

/**
 * A XULWidgetSingleWrapper is a wrapper around a single instance of a XUL
 * widget in a particular window.
 */
function XULWidgetSingleWrapper(aWidgetId, aNode, aDocument) {
  this.isGroup = false;

  this.id = aWidgetId;
  this.type = "custom";
  this.provider = CustomizableUI.PROVIDER_XUL;

  let weakDoc = Cu.getWeakReference(aDocument);
  // If we keep a strong ref, the weak ref will never die, so null it out:
  aDocument = null;

  this.__defineGetter__("node", function () {
    // If we've set this to null (further down), we're sure there's nothing to
    // be gotten here, so bail out early:
    if (!weakDoc) {
      return null;
    }
    if (aNode) {
      // Return the last known node if it's still in the DOM...
      if (aNode.isConnected) {
        return aNode;
      }
      // ... or the toolbox
      let toolbox = aNode.ownerGlobal.gNavToolbox;
      if (toolbox && toolbox.palette && aNode.parentNode == toolbox.palette) {
        return aNode;
      }
      // If it isn't, clear the cached value and fall through to the "slow" case:
      aNode = null;
    }

    let doc = weakDoc.get();
    if (doc) {
      // Store locally so we can cache the result:
      aNode = CustomizableUIInternal.findWidgetInWindow(
        aWidgetId,
        doc.defaultView
      );
      return aNode;
    }
    // The weakref to the document is dead, we're done here forever more:
    weakDoc = null;
    return null;
  });

  this.__defineGetter__("anchor", function () {
    let anchorId;
    // First check for an anchor for the area:
    let placement = CustomizableUIInternal.getPlacementOfWidget(aWidgetId);
    if (placement) {
      anchorId = gAreas.get(placement.area).get("anchor");
    }

    let node = this.node;
    if (!anchorId && node) {
      anchorId = node.getAttribute("cui-anchorid");
    }

    return anchorId && node
      ? node.ownerDocument.getElementById(anchorId)
      : node;
  });

  this.__defineGetter__("overflowed", function () {
    let node = this.node;
    if (!node) {
      return false;
    }
    return node.getAttribute("overflowedItem") == "true";
  });

  Object.freeze(this);
}

/**
 * OverflowableToolbar is a class that gives a <xul:toolbar> the ability to send
 * toolbar items that are "overflowable" to lists in separate panels if and
 * when the toolbar shrinks enough so that those items overflow out of bounds.
 * Secondly, this class manages moving things out from those panels and back
 * into the toolbar once it underflows and has the space to accommodate the
 * items that had originally overflowed out.
 *
 * There are two panels that toolbar items can be overflowed to:
 *
 * 1. The default items overflow panel
 *   This is where built-in default toolbar items will go to.
 * 2. The Unified Extensions panel
 *   This is where browser_action toolbar buttons created by extensions will
 *   go to if the Unified Extensions UI is enabled - otherwise, those items will
 *   go to the default items overflow panel.
 *
 * Finally, OverflowableToolbar manages the showing of the default items
 * overflow panel when the associated anchor is clicked or dragged over. The
 * Unified Extensions panel is managed separately by the extension code.
 *
 * In theory, we could have multiple overflowable toolbars, but in practice,
 * only the nav-bar (CustomizableUI.AREA_NAVBAR) makes use of this class.
 */
class OverflowableToolbar {
  /**
   * The OverflowableToolbar class is constructed during browser window
   * creation, but to optimize for window painting, we defer most work until
   * after the window has painted. This property is set to true once
   * initialization has completed.
   *
   * @type {boolean}
   */
  #initialized = false;

  /**
   * A reference to the <xul:toolbar> that is overflowable.
   *
   * @type {Element}
   */
  #toolbar = null;

  /**
   * A reference to the part of the <xul:toolbar> that accepts CustomizableUI
   * widgets.
   *
   * @type {Element}
   */
  #target = null;

  /**
   * A mapping from the ID of a toolbar item that has overflowed to the width
   * that the toolbar item occupied in the toolbar at the time of overflow. Any
   * item that is currently overflowed will have an entry in this map.
   *
   * @type {Map<string, number>}
   */
  #overflowedInfo = new Map();

  /**
   * The set of overflowed DOM nodes that were hidden at the time of overflowing.
   */
  #hiddenOverflowedNodes = new WeakSet();

  /**
   * True if the overflowable toolbar is actively handling overflows and
   * underflows. This value is set internally by the private #enable() and
   * #disable() methods.
   *
   * @type {boolean}
   */
  #enabled = true;

  /**
   * A reference to the element that overflowed toolbar items will be
   * appended to as children upon overflow.
   *
   * @type {Element}
   */
  #defaultList = null;

  /**
   * A reference to the button that opens the overflow panel. This is also
   * the element that the panel will anchor to.
   *
   * @type {Element}
   */
  #defaultListButton = null;

  /**
   * A reference to the <xul:panel> overflow panel that contains the #defaultList
   * element.
   *
   * @type {Element}
   */
  #defaultListPanel = null;

  /**
   * A reference to the the element that overflowed extension browser action
   * toolbar items will be appended to as children upon overflow if the
   * Unified Extension UI is enabled. This is created lazily and might be null,
   * so you should use the #webExtList memoizing getter instead to get this.
   *
   * @type {Element|null}
   */
  #webExtListRef = null;

  /**
   * An empty object that is created in #checkOverflow to identify individual
   * calls to #checkOverflow and avoid re-entrancy (since #checkOverflow is
   * asynchronous, and in theory, could be called multiple times before any of
   * those times have a chance to fully exit).
   *
   * @type {Object}
   */
  #checkOverflowHandle = null;

  /**
   * A timeout ID returned by setTimeout that identifies a timeout function that
   * runs to hide the #defaultListPanel if the user happened to open the panel by dragging
   * over the #defaultListButton and then didn't hover any part of the #defaultListPanel.
   *
   * @type {number}
   */
  #hideTimeoutId = null;

  /**
   * Public methods start here.
   */

  /**
   * OverflowableToolbar constructor. This is run very early on in the lifecycle
   * of a browser window, so it tries to defer most work to the init() method
   * instead after first paint.
   *
   * Upon construction, a "overflowable" attribute will be set on the
   * toolbar, set to the value of "true".
   *
   * Part of the API for OverflowableToolbar is declarative, in that it expects
   * certain attributes to be set on the <xul:toolbar> that is overflowable.
   * Those attributes are:
   *
   * default-overflowbutton:
   *   The ID of the button that is used to open and anchor the overflow panel.
   * default-overflowtarget:
   *   The ID of the element that overflowed items will be appended to as
   *   children. Note that the overflowed toolbar items are moved into and out
   *   of this overflow target, so it is definitely advisable to let
   *   OverflowableToolbar own managing the children of default-overflowtarget,
   *   and to not modify it outside of this class.
   * default-overflowpanel:
   *   The ID of the <xul:panel> that contains the default-overflowtarget.
   * addon-webext-overflowbutton:
   *   The ID of the button that is used to open and anchor the Unified
   *   Extensions panel.
   * addon-webext-overflowtarget:
   *   The ID of the element that overflowed extension toolbar buttons will
   *   be appended to as children if the Unified Extensions UI is enabled.
   *   Note that the overflowed toolbar items are moved into and out of this
   *   overflow target, so it is definitely advisable to let OverflowableToolbar
   *   own managing the children of addon-webext-overflowtarget, and to not
   *   modify it outside of this class.
   *
   * @param {Element} aToolbarNode The <xul:toolbar> that will be overflowable.
   * @throws {Error} Throws if the customization target of the toolbar somehow
   *   isn't a direct descendent of the toolbar.
   */
  constructor(aToolbarNode) {
    this.#toolbar = aToolbarNode;
    this.#target = CustomizableUI.getCustomizationTarget(this.#toolbar);
    if (this.#target.parentNode != this.#toolbar) {
      throw new Error(
        "Customization target must be a direct child of an overflowable toolbar."
      );
    }

    this.#toolbar.setAttribute("overflowable", "true");
    let doc = this.#toolbar.ownerDocument;
    this.#defaultList = doc.getElementById(
      this.#toolbar.getAttribute("default-overflowtarget")
    );
    this.#defaultList._customizationTarget = this.#defaultList;

    let window = this.#toolbar.ownerGlobal;

    if (window.gBrowserInit.delayedStartupFinished) {
      this.init();
    } else {
      Services.obs.addObserver(this, "browser-delayed-startup-finished");
    }
  }

  /**
   * Does final initialization of the OverflowableToolbar after the window has
   * first painted. This will also kick off the first check to see if overflow
   * has already occurred at the time of initialization.
   */
  init() {
    let doc = this.#toolbar.ownerDocument;
    let window = doc.defaultView;
    window.addEventListener("resize", this);
    window.gNavToolbox.addEventListener("customizationstarting", this);
    window.gNavToolbox.addEventListener("aftercustomization", this);

    let defaultListButton = this.#toolbar.getAttribute(
      "default-overflowbutton"
    );
    this.#defaultListButton = doc.getElementById(defaultListButton);
    this.#defaultListButton.addEventListener("mousedown", this);
    this.#defaultListButton.addEventListener("keypress", this);
    this.#defaultListButton.addEventListener("dragover", this);
    this.#defaultListButton.addEventListener("dragend", this);

    let panelId = this.#toolbar.getAttribute("default-overflowpanel");
    this.#defaultListPanel = doc.getElementById(panelId);
    this.#defaultListPanel.addEventListener("popuphiding", this);
    CustomizableUIInternal.addPanelCloseListeners(this.#defaultListPanel);

    CustomizableUI.addListener(this);

    this.#checkOverflow();

    this.#initialized = true;
  }

  /**
   * Almost the exact reverse of init(). This is called when the browser window
   * is unloading.
   */
  uninit() {
    this.#toolbar.removeAttribute("overflowable");

    if (!this.#initialized) {
      Services.obs.removeObserver(this, "browser-delayed-startup-finished");
      return;
    }

    this.#disable();

    let window = this.#toolbar.ownerGlobal;
    window.removeEventListener("resize", this);
    window.gNavToolbox.removeEventListener("customizationstarting", this);
    window.gNavToolbox.removeEventListener("aftercustomization", this);
    this.#defaultListButton.removeEventListener("mousedown", this);
    this.#defaultListButton.removeEventListener("keypress", this);
    this.#defaultListButton.removeEventListener("dragover", this);
    this.#defaultListButton.removeEventListener("dragend", this);
    this.#defaultListPanel.removeEventListener("popuphiding", this);

    CustomizableUI.removeListener(this);
    CustomizableUIInternal.removePanelCloseListeners(this.#defaultListPanel);
  }

  /**
   * Opens the overflow #defaultListPanel if it's not already open. If the panel is in
   * the midst of hiding when this is called, the panel will be re-opened.
   *
   * @returns {Promise}
   * @resolves {undefined} once the panel is open.
   */
  show(aEvent) {
    if (this.#defaultListPanel.state == "open") {
      return Promise.resolve();
    }
    return new Promise(resolve => {
      let doc = this.#defaultListPanel.ownerDocument;
      this.#defaultListPanel.hidden = false;
      let multiview = this.#defaultListPanel.querySelector("panelmultiview");
      let mainViewId = multiview.getAttribute("mainViewId");
      let mainView = doc.getElementById(mainViewId);
      let contextMenu = doc.getElementById(mainView.getAttribute("context"));
      contextMenu.addEventListener("command", this, {
        capture: true,
        mozSystemGroup: true,
      });
      let anchor = this.#defaultListButton.icon;

      let popupshown = false;
      this.#defaultListPanel.addEventListener(
        "popupshown",
        () => {
          popupshown = true;
          this.#defaultListPanel.addEventListener("dragover", this);
          this.#defaultListPanel.addEventListener("dragend", this);
          // Wait until the next tick to resolve so all popupshown
          // handlers have a chance to run before our promise resolution
          // handlers do.
          Services.tm.dispatchToMainThread(resolve);
        },
        { once: true }
      );

      let openPanel = () => {
        // Ensure we update the gEditUIVisible flag when opening the popup, in
        // case the edit controls are in it.
        this.#defaultListPanel.addEventListener(
          "popupshowing",
          () => {
            doc.defaultView.updateEditUIVisibility();
          },
          { once: true }
        );

        this.#defaultListPanel.addEventListener(
          "popuphidden",
          () => {
            if (!popupshown) {
              // The panel was hidden again before it was shown. This can break
              // consumers waiting for the panel to show. So we try again.
              openPanel();
            }
          },
          { once: true }
        );

        lazy.PanelMultiView.openPopup(
          this.#defaultListPanel,
          anchor || this.#defaultListButton,
          {
            triggerEvent: aEvent,
          }
        );
        this.#defaultListButton.open = true;
      };

      openPanel();
    });
  }

  /**
   * Exposes whether #checkOverflow is currently running.
   *
   * @returns {boolean} True if #checkOverflow is currently running.
   */
  isHandlingOverflow() {
    return !!this.#checkOverflowHandle;
  }

  /**
   * Finds the most appropriate place to insert toolbar item aNode if we've been
   * asked to put it into the overflowable toolbar without being told exactly
   * where.
   *
   * @param {Element} aNode The toolbar item being inserted.
   * @returns {Array} [parent, nextNode]
   *   parent: {Element} The parent element that should contain aNode.
   *   nextNode: {Element|null} The node that should follow aNode after
   *     insertion, if any. If this is null, aNode should be placed at the end
   *     of parent.
   */
  findOverflowedInsertionPoints(aNode) {
    let newNodeCanOverflow = aNode.getAttribute("overflows") != "false";
    let areaId = this.#toolbar.id;
    let placements = gPlacements.get(areaId);
    let nodeIndex = placements.indexOf(aNode.id);
    let nodeBeforeNewNodeIsOverflown = false;

    let loopIndex = -1;
    // Loop through placements to find where to insert this item.
    // As soon as we find an overflown widget, we will only
    // insert in the overflow panel (this is why we check placements
    // before the desired location for the new node). Once we pass
    // the desired location of the widget, we look for placement ids
    // that actually have DOM equivalents to insert before. If all
    // else fails, we insert at the end of either the overflow list
    // or the toolbar target.
    while (++loopIndex < placements.length) {
      let nextNodeId = placements[loopIndex];
      if (loopIndex > nodeIndex) {
        // Note that if aNode is in a template, its `ownerDocument` is *not*
        // going to be the browser.xhtml document, so we cannot rely on it.
        let nextNode = this.#toolbar.ownerDocument.getElementById(nextNodeId);
        // If the node we're inserting can overflow, and the next node
        // in the toolbar is overflown, we should insert this node
        // in the overflow panel before it.
        if (
          newNodeCanOverflow &&
          this.#overflowedInfo.has(nextNodeId) &&
          nextNode &&
          nextNode.parentNode == this.#defaultList
        ) {
          return [this.#defaultList, nextNode];
        }
        // Otherwise (if either we can't overflow, or the previous node
        // wasn't overflown), and the next node is in the toolbar itself,
        // insert the node in the toolbar.
        if (
          (!nodeBeforeNewNodeIsOverflown || !newNodeCanOverflow) &&
          nextNode &&
          (nextNode.parentNode == this.#target ||
            // Also check if the next node is in a customization wrapper
            // (toolbarpaletteitem). We don't need to do this for the
            // overflow case because overflow is disabled in customize mode.
            (nextNode.parentNode.localName == "toolbarpaletteitem" &&
              nextNode.parentNode.parentNode == this.#target))
        ) {
          return [this.#target, nextNode];
        }
      } else if (
        loopIndex < nodeIndex &&
        this.#overflowedInfo.has(nextNodeId)
      ) {
        nodeBeforeNewNodeIsOverflown = true;
      }
    }

    let overflowList = CustomizableUI.isWebExtensionWidget(aNode.id)
      ? this.#webExtList
      : this.#defaultList;

    let containerForAppending =
      this.#overflowedInfo.size && newNodeCanOverflow
        ? overflowList
        : this.#target;
    return [containerForAppending, null];
  }

  /**
   * Allows callers to query for the current parent of a toolbar item that may
   * or may not be overflowed. That parent will either be #defaultList,
   * #webExtList (if it's an extension button) or #target.
   *
   * Note: It is assumed that the caller has verified that aNode is placed
   * within the toolbar customizable area according to CustomizableUI.
   *
   * @param {Element} aNode the node that can be overflowed by this
   *   OverflowableToolbar.
   * @returns {Element} The current containing node for aNode.
   */
  getContainerFor(aNode) {
    if (aNode.getAttribute("overflowedItem") == "true") {
      return CustomizableUI.isWebExtensionWidget(aNode.id)
        ? this.#webExtList
        : this.#defaultList;
    }
    return this.#target;
  }

  /**
   * Private methods start here.
   */

  /**
   * Handle overflow in the toolbar by moving items to the overflow menu.
   */
  async #onOverflow() {
    if (!this.#enabled) {
      return;
    }

    let win = this.#target.ownerGlobal;
    let checkOverflowHandle = this.#checkOverflowHandle;
    let webExtButtonID = this.#toolbar.getAttribute(
      "addon-webext-overflowbutton"
    );

    let { isOverflowing, targetContentWidth } = await this.#getOverflowInfo();

    // Stop if the window has closed or if we re-enter while waiting for
    // layout.
    if (win.closed || this.#checkOverflowHandle != checkOverflowHandle) {
      lazy.log.debug("Window closed or another overflow handler started.");
      return;
    }

    let webExtList = this.#webExtList;

    let child = this.#target.lastElementChild;
    while (child && isOverflowing) {
      let prevChild = child.previousElementSibling;

      if (child.getAttribute("overflows") != "false") {
        this.#overflowedInfo.set(child.id, targetContentWidth);
        let { width: childWidth } =
          win.windowUtils.getBoundsWithoutFlushing(child);
        if (!childWidth) {
          this.#hiddenOverflowedNodes.add(child);
        }

        child.setAttribute("overflowedItem", true);
        CustomizableUIInternal.ensureButtonContextMenu(
          child,
          this.#toolbar,
          true
        );
        CustomizableUIInternal.notifyListeners(
          "onWidgetOverflow",
          child,
          this.#target
        );

        if (webExtList && CustomizableUI.isWebExtensionWidget(child.id)) {
          child.setAttribute("cui-anchorid", webExtButtonID);
          webExtList.insertBefore(child, webExtList.firstElementChild);
        } else {
          child.setAttribute("cui-anchorid", this.#defaultListButton.id);
          this.#defaultList.insertBefore(
            child,
            this.#defaultList.firstElementChild
          );
          if (!CustomizableUI.isSpecialWidget(child.id) && childWidth) {
            this.#toolbar.setAttribute("overflowing", "true");
          }
        }
      }
      child = prevChild;
      ({ isOverflowing, targetContentWidth } = await this.#getOverflowInfo());
      // Stop if the window has closed or if we re-enter while waiting for
      // layout.
      if (win.closed || this.#checkOverflowHandle != checkOverflowHandle) {
        lazy.log.debug("Window closed or another overflow handler started.");
        return;
      }
    }

    win.UpdateUrlbarSearchSplitterState();
  }

  /**
   * Returns a Promise that resolves to a an object that describes the state
   * that this OverflowableToolbar is currently in.
   *
   * @returns {Promise}
   * @resolves {Object}
   *   An object with the following properties:
   *
   *   isOverflowing: {boolean} True if at least one toolbar item has overflowed
   *     into an overflow panel.
   *   targetContentWidth: {number} The total width of the items within the
   *     customization target area of the toolbar.
   *   totalAvailWidth: {number} The maximum width items in the toolbar may
   *     occupy before causing an overflow.
   */
  async #getOverflowInfo() {
    function getInlineSize(aElement) {
      return aElement.getBoundingClientRect().width;
    }

    function sumChildrenInlineSize(aParent, aExceptChild = null) {
      let sum = 0;
      for (let child of aParent.children) {
        let style = win.getComputedStyle(child);
        if (
          style.display == "none" ||
          win.XULPopupElement.isInstance(child) ||
          (style.position != "static" && style.position != "relative")
        ) {
          continue;
        }
        sum += parseFloat(style.marginLeft) + parseFloat(style.marginRight);
        if (child != aExceptChild) {
          sum += getInlineSize(child);
        }
      }
      return sum;
    }

    let win = this.#target.ownerGlobal;
    let totalAvailWidth;
    let targetWidth;
    let targetChildrenWidth;

    await win.promiseDocumentFlushed(() => {
      let style = win.getComputedStyle(this.#toolbar);
      let toolbarChildrenWidth = sumChildrenInlineSize(
        this.#toolbar,
        this.#target
      );
      totalAvailWidth =
        getInlineSize(this.#toolbar) -
        parseFloat(style.paddingLeft) -
        parseFloat(style.paddingRight) -
        toolbarChildrenWidth;
      targetWidth = getInlineSize(this.#target);
      targetChildrenWidth =
        this.#target == this.#toolbar
          ? toolbarChildrenWidth
          : sumChildrenInlineSize(this.#target);
    });

    lazy.log.debug(
      `Getting overflow info: target width: ${targetWidth} (${targetChildrenWidth}); avail: ${totalAvailWidth}`
    );

    // If the target has min-width: 0, their children might actually overflow
    // it, so check for both cases explicitly.
    let targetContentWidth = Math.max(targetWidth, targetChildrenWidth);
    let isOverflowing = Math.floor(targetContentWidth) > totalAvailWidth;
    return { isOverflowing, targetContentWidth, totalAvailWidth };
  }

  /**
   * Tries to move toolbar items back to the toolbar from the overflow panel.
   *
   * @param {boolean} shouldMoveAllItems
   *        Whether we should move everything (e.g. because we're being
   *        disabled)
   * @param {number} [totalAvailWidth=undefined]
   *        Optional; the width of the toolbar area in which we can put things.
   *        Some consumers pass this to avoid reflows.
   *
   *        While there are items in the list, this width won't change, and so
   *        we can avoid flushing layout by providing it and/or caching it.
   *        Note that if `shouldMoveAllItems` is true, we never need the width
   *        anyway, and this value is ignored.
   * @returns {Promise}
   * @resolves {undefined} Once moving of items has completed.
   */
  async #moveItemsBackToTheirOrigin(shouldMoveAllItems, totalAvailWidth) {
    lazy.log.debug(
      `Attempting to move ${shouldMoveAllItems ? "all" : "some"} items back`
    );
    let placements = gPlacements.get(this.#toolbar.id);
    let win = this.#target.ownerGlobal;
    let doc = this.#target.ownerDocument;
    let checkOverflowHandle = this.#checkOverflowHandle;

    let overflowedItemStack = Array.from(this.#overflowedInfo.entries());

    for (let i = overflowedItemStack.length - 1; i >= 0; --i) {
      let [childID, minSize] = overflowedItemStack[i];

      // The item may have been placed inside of a <xul:panel> that is lazily
      // loaded and still in the view cache. PanelMultiView.getViewNode will
      // do the work of checking the DOM for the child, and then falling back to
      // the cache if that is the case.
      let child = lazy.PanelMultiView.getViewNode(doc, childID);

      if (!child) {
        this.#overflowedInfo.delete(childID);
        continue;
      }

      lazy.log.debug(
        `Considering moving ${child.id} back, minSize: ${minSize}`
      );

      if (!shouldMoveAllItems && minSize) {
        if (!totalAvailWidth) {
          ({ totalAvailWidth } = await this.#getOverflowInfo());

          // If the window has closed or if we re-enter because we were waiting
          // for layout, stop.
          if (win.closed || this.#checkOverflowHandle != checkOverflowHandle) {
            lazy.log.debug("Window closed or #checkOverflow called again.");
            return;
          }
        }
        if (totalAvailWidth <= minSize) {
          lazy.log.debug(
            `Need ${minSize} but width is ${totalAvailWidth} so bailing`
          );
          break;
        }
      }

      lazy.log.debug(`Moving ${child.id} back`);
      this.#overflowedInfo.delete(child.id);
      let beforeNodeIndex = placements.indexOf(child.id) + 1;
      // If this is a skipintoolbarset item, meaning it doesn't occur in the placements list,
      // we're inserting it at the end. This will mean first-in, first-out (more or less)
      // leading to as little change in order as possible.
      if (beforeNodeIndex == 0) {
        beforeNodeIndex = placements.length;
      }
      let inserted = false;
      for (; beforeNodeIndex < placements.length; beforeNodeIndex++) {
        let beforeNode = this.#target.getElementsByAttribute(
          "id",
          placements[beforeNodeIndex]
        )[0];
        // Unfortunately, XUL add-ons can mess with nodes after they are inserted,
        // and this breaks the following code if the button isn't where we expect
        // it to be (ie not a child of the target). In this case, ignore the node.
        if (beforeNode && this.#target == beforeNode.parentElement) {
          this.#target.insertBefore(child, beforeNode);
          inserted = true;
          break;
        }
      }
      if (!inserted) {
        this.#target.appendChild(child);
      }
      child.removeAttribute("cui-anchorid");
      child.removeAttribute("overflowedItem");
      CustomizableUIInternal.ensureButtonContextMenu(child, this.#target);
      CustomizableUIInternal.notifyListeners(
        "onWidgetUnderflow",
        child,
        this.#target
      );
    }

    win.UpdateUrlbarSearchSplitterState();

    let defaultListItems = Array.from(this.#defaultList.children);
    if (
      defaultListItems.every(
        item =>
          CustomizableUI.isSpecialWidget(item.id) ||
          this.#hiddenOverflowedNodes.has(item)
      )
    ) {
      this.#toolbar.removeAttribute("overflowing");
    }
  }

  /**
   * Checks to see if there are overflowable items within the customization
   * target of the toolbar that should be moved into the overflow panel, and
   * if there are, moves them.
   *
   * Note that since this is an async function that can be called in bursts
   * by resize events on the window, this function is often re-called even
   * when a prior call hasn't yet resolved. In that situation, the older calls
   * resolve early without doing any work and leave any DOM manipulation to the
   * most recent call.
   *
   * This function is a no-op if the OverflowableToolbar is disabled or the
   * DOM fullscreen UI is currently being used.
   *
   * @returns {Promise}
   * @resolves {undefined} Once any movement of toolbar items has completed.
   */
  async #checkOverflow() {
    if (!this.#enabled) {
      return;
    }

    let win = this.#target.ownerGlobal;
    if (win.document.documentElement.hasAttribute("inDOMFullscreen")) {
      // Toolbars are hidden and cannot be made visible in DOM fullscreen mode
      // so there's nothing to do here.
      return;
    }

    let checkOverflowHandle = (this.#checkOverflowHandle = {});

    lazy.log.debug("Checking overflow");
    let { isOverflowing, totalAvailWidth } = await this.#getOverflowInfo();
    if (win.closed || this.#checkOverflowHandle != checkOverflowHandle) {
      return;
    }

    if (isOverflowing) {
      await this.#onOverflow();
    } else {
      await this.#moveItemsBackToTheirOrigin(false, totalAvailWidth);
    }

    if (checkOverflowHandle == this.#checkOverflowHandle) {
      this.#checkOverflowHandle = null;
    }
  }

  /**
   * Makes the OverflowableToolbar inert and moves all overflowable items back
   * into the customization target of the toolbar.
   */
  #disable() {
    // Abort any ongoing overflow check. #enable() will #checkOverflow()
    // anyways, so this is enough.
    this.#checkOverflowHandle = {};
    this.#moveItemsBackToTheirOrigin(true);
    this.#enabled = false;
  }

  /**
   * Puts the OverflowableToolbar into the enabled state and then checks to see
   * if any of the items in the customization target should be overflowed into
   * the overflow panel list.
   */
  #enable() {
    this.#enabled = true;
    this.#checkOverflow();
  }

  /**
   * Shows the overflow panel and sets a timeout to automatically re-hide the
   * panel if it is not being hovered.
   */
  #showWithTimeout() {
    const OVERFLOW_PANEL_HIDE_DELAY_MS = 500;

    this.show().then(() => {
      let window = this.#toolbar.ownerGlobal;
      if (this.#hideTimeoutId) {
        window.clearTimeout(this.#hideTimeoutId);
      }
      this.#hideTimeoutId = window.setTimeout(() => {
        if (!this.#defaultListPanel.firstElementChild.matches(":hover")) {
          lazy.PanelMultiView.hidePopup(this.#defaultListPanel);
        }
      }, OVERFLOW_PANEL_HIDE_DELAY_MS);
    });
  }

  /**
   * Gets and caches a reference to the DOM node with the ID set as the value
   * of addon-webext-overflowtarget. If a cache already exists, that's returned
   * instead. If addon-webext-overflowtarget has no value, null is returned.
   *
   * @returns {Element|null} the list that overflowed extension toolbar
   *   buttons should go to if the Unified Extensions UI is enabled, or null
   *   if no such list exists.
   */
  get #webExtList() {
    if (!this.#webExtListRef) {
      let targetID = this.#toolbar.getAttribute("addon-webext-overflowtarget");
      if (!targetID) {
        throw new Error(
          "addon-webext-overflowtarget was not defined on the " +
            `overflowable toolbar with id: ${this.#toolbar.id}`
        );
      }
      let win = this.#toolbar.ownerGlobal;
      let { panel } = win.gUnifiedExtensions;
      this.#webExtListRef = panel.querySelector(`#${targetID}`);
    }
    return this.#webExtListRef;
  }

  /**
   * Returns true if aNode is not null and is one of either this.#webExtList or
   * this.#defaultList.
   *
   * @param {DOMElement} aNode The node to test.
   * @returns {boolean}
   */
  #isOverflowList(aNode) {
    return aNode == this.#defaultList || aNode == this.#webExtList;
  }

  /**
   * Private event handlers start here.
   */

  /**
   * Handles clicks on the #defaultListButton element.
   *
   * @param {MouseEvent} aEvent the click event.
   */
  #onClickDefaultListButton(aEvent) {
    if (this.#defaultListButton.open) {
      this.#defaultListButton.open = false;
      lazy.PanelMultiView.hidePopup(this.#defaultListPanel);
    } else if (
      this.#defaultListPanel.state != "hiding" &&
      !this.#defaultListButton.disabled
    ) {
      this.show(aEvent);
    }
  }

  /**
   * Handles the popuphiding event firing on the #defaultListPanel.
   *
   * @param {WidgetMouseEvent} aEvent the popuphiding event that fired on the
   *   #defaultListPanel.
   */
  #onPanelHiding(aEvent) {
    if (aEvent.target != this.#defaultListPanel) {
      // Ignore context menus, <select> popups, etc.
      return;
    }
    this.#defaultListButton.open = false;
    this.#defaultListPanel.removeEventListener("dragover", this);
    this.#defaultListPanel.removeEventListener("dragend", this);
    let doc = aEvent.target.ownerDocument;
    doc.defaultView.updateEditUIVisibility();
    let contextMenuId = this.#defaultListPanel.getAttribute("context");
    if (contextMenuId) {
      let contextMenu = doc.getElementById(contextMenuId);
      contextMenu.removeEventListener("command", this, {
        capture: true,
        mozSystemGroup: true,
      });
    }
  }

  /**
   * Handles a resize event fired on the window hosting this
   * OverflowableToolbar.
   *
   * @param {UIEvent} aEvent the resize event.
   */
  #onResize(aEvent) {
    // Ignore bubbled-up resize events.
    if (aEvent.target != aEvent.currentTarget) {
      return;
    }
    this.#checkOverflow();
  }

  /**
   * CustomizableUI listener methods start here.
   */

  onWidgetBeforeDOMChange(aNode, aNextNode, aContainer) {
    // This listener method is used to handle the case where a widget is
    // moved or removed from an area via the CustomizableUI API while
    // overflowed. It reorganizes the internal state of this OverflowableToolbar
    // to handle that change.
    if (!this.#enabled || !this.#isOverflowList(aContainer)) {
      return;
    }
    // When we (re)move an item, update all the items that come after it in the list
    // with the minsize *of the item before the to-be-removed node*. This way, we
    // ensure that we try to move items back as soon as that's possible.
    let updatedMinSize;
    if (aNode.previousElementSibling) {
      updatedMinSize = this.#overflowedInfo.get(
        aNode.previousElementSibling.id
      );
    } else {
      // Force (these) items to try to flow back into the bar:
      updatedMinSize = 1;
    }
    let nextItem = aNode.nextElementSibling;
    while (nextItem) {
      this.#overflowedInfo.set(nextItem.id, updatedMinSize);
      nextItem = nextItem.nextElementSibling;
    }
  }

  onWidgetAfterDOMChange(aNode, aNextNode, aContainer) {
    // This listener method is used to handle the case where a widget is
    // moved or removed from an area via the CustomizableUI API while
    // overflowed. It updates the DOM in the event that the movement or removal
    // causes overflow or underflow of the toolbar.
    if (
      !this.#enabled ||
      (aContainer != this.#target && !this.#isOverflowList(aContainer))
    ) {
      return;
    }

    let nowOverflowed = this.#isOverflowList(aNode.parentNode);
    let wasOverflowed = this.#overflowedInfo.has(aNode.id);

    // If this wasn't overflowed before...
    if (!wasOverflowed) {
      // ... but it is now, then we added to one of the overflow panels.
      if (nowOverflowed) {
        // We could be the first item in the overflow panel if we're being inserted
        // before the previous first item in it. We can't assume the minimum
        // size is the same (because the other item might be much wider), so if
        // there is no previous item, just allow this item to be put back in the
        // toolbar immediately by specifying a very low minimum size.
        let sourceOfMinSize = aNode.previousElementSibling;
        let minSize = sourceOfMinSize
          ? this.#overflowedInfo.get(sourceOfMinSize.id)
          : 1;
        this.#overflowedInfo.set(aNode.id, minSize);
        aNode.setAttribute("cui-anchorid", this.#defaultListButton.id);
        aNode.setAttribute("overflowedItem", true);
        CustomizableUIInternal.ensureButtonContextMenu(aNode, aContainer, true);
        CustomizableUIInternal.notifyListeners(
          "onWidgetOverflow",
          aNode,
          this.#target
        );
      }
    } else if (!nowOverflowed) {
      // If it used to be overflowed...
      // ... and isn't anymore, let's remove our bookkeeping:
      this.#overflowedInfo.delete(aNode.id);
      aNode.removeAttribute("cui-anchorid");
      aNode.removeAttribute("overflowedItem");
      CustomizableUIInternal.ensureButtonContextMenu(aNode, aContainer);
      CustomizableUIInternal.notifyListeners(
        "onWidgetUnderflow",
        aNode,
        this.#target
      );

      let collapsedWidgetIds = Array.from(this.#overflowedInfo.keys());
      if (collapsedWidgetIds.every(w => CustomizableUI.isSpecialWidget(w))) {
        this.#toolbar.removeAttribute("overflowing");
      }
    } else if (aNode.previousElementSibling) {
      // but if it still is, it must have changed places. Bookkeep:
      let prevId = aNode.previousElementSibling.id;
      let minSize = this.#overflowedInfo.get(prevId);
      this.#overflowedInfo.set(aNode.id, minSize);
    }

    // We might overflow now if an item was added, or we may be able to move
    // stuff back into the toolbar if an item was removed.
    this.#checkOverflow();
  }

  /**
   * @returns {Boolean} whether the given node is in the overflow list.
   */
  isInOverflowList(node) {
    return node.parentNode == this.#defaultList;
  }

  /**
   * nsIObserver implementation starts here.
   */

  observe(aSubject, aTopic) {
    // This nsIObserver method allows us to defer initialization until after
    // this window has finished painting and starting up.
    if (
      aTopic == "browser-delayed-startup-finished" &&
      aSubject == this.#toolbar.ownerGlobal
    ) {
      Services.obs.removeObserver(this, "browser-delayed-startup-finished");
      this.init();
    }
  }

  /**
   * nsIDOMEventListener implementation starts here.
   */

  handleEvent(aEvent) {
    switch (aEvent.type) {
      case "aftercustomization": {
        this.#enable();
        break;
      }
      case "mousedown": {
        if (aEvent.button != 0) {
          break;
        }
        if (aEvent.target == this.#defaultListButton) {
          this.#onClickDefaultListButton(aEvent);
        } else {
          lazy.PanelMultiView.hidePopup(this.#defaultListPanel);
        }
        break;
      }
      case "keypress": {
        if (
          aEvent.target == this.#defaultListButton &&
          (aEvent.key == " " || aEvent.key == "Enter")
        ) {
          this.#onClickDefaultListButton(aEvent);
        }
        break;
      }
      case "customizationstarting": {
        this.#disable();
        break;
      }
      case "dragover": {
        if (this.#enabled) {
          this.#showWithTimeout();
        }
        break;
      }
      case "dragend": {
        lazy.PanelMultiView.hidePopup(this.#defaultListPanel);
        break;
      }
      case "popuphiding": {
        this.#onPanelHiding(aEvent);
        break;
      }
      case "resize": {
        this.#onResize(aEvent);
        break;
      }
    }
  }
}

CustomizableUIInternal.initialize();
