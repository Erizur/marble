/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from aboutDialog-appUpdater.js */

// Services = object with smart getters for common XPCOM services
var { AppConstants } = ChromeUtils.importESModule(
  "resource://gre/modules/AppConstants.sys.mjs"
);
if (AppConstants.MOZ_UPDATER) {
  Services.scriptloader.loadSubScript(
    "chrome://browser/content/aboutDialog-appUpdater.js",
    this
  );
}

function init() {
  let defaults = Services.prefs.getDefaultBranch(null);
  let distroId = defaults.getCharPref("distribution.id", "");
  if (distroId) {
    let distroAbout = defaults.getStringPref("distribution.about", "");
    // If there is about text, we always show it.
    if (distroAbout) {
      let distroField = document.getElementById("distribution");
      distroField.value = distroAbout;
      distroField.style.display = "block";
    }
    // If it's not a mozilla distribution, show the rest,
    // unless about text exists, then we always show.
    if (!distroId.startsWith("mozilla-") || distroAbout) {
      let distroVersion = defaults.getCharPref("distribution.version", "");
      if (distroVersion) {
        distroId += " - " + distroVersion;
      }

      let distroIdField = document.getElementById("distributionId");
      distroIdField.value = distroId;
      distroIdField.style.display = "block";
    }
  }

  // Include the build ID and display warning if this is an "a#" (nightly or aurora) build
  let versionId = "aboutDialog-version";
  let versionAttributes = {
    version: AppConstants.MOZ_APP_VERSION_DISPLAY,
    bits: Services.appinfo.is64Bit ? 64 : 32,
  };

  let version = Services.appinfo.version;
  if (/a\d+$/.test(version)) {
    versionId = "aboutDialog-version-nightly";
    let buildID = Services.appinfo.appBuildID;
    let year = buildID.slice(0, 4);
    let month = buildID.slice(4, 6);
    let day = buildID.slice(6, 8);
    versionAttributes.isodate = `${year}-${month}-${day}`;

    document.getElementById("experimental").hidden = false;
    document.getElementById("communityDesc").hidden = true;
  }

  // Use Fluent arguments for append version and the architecture of the build
  let versionField = document.getElementById("version");

  document.l10n.setAttributes(versionField, versionId, versionAttributes);

  // Show a release notes link if we have a URL.
  let relNotesLink = document.getElementById("releasenotes");
  let relNotesPrefType = Services.prefs.getPrefType(
    "app.releaseNotesURL.aboutDialog"
  );
  if (relNotesPrefType != Services.prefs.PREF_INVALID) {
    let relNotesURL = Services.urlFormatter.formatURLPref(
      "app.releaseNotesURL.aboutDialog"
    );
    if (relNotesURL != "about:blank") {
      relNotesLink.href = relNotesURL;
      relNotesLink.hidden = false;
    }
  }

  if (AppConstants.MOZ_UPDATER) {
    gAppUpdater = new appUpdater({ buttonAutoFocus: true });

    let channelLabel = document.getElementById("currentChannelText");
    let channelAttrs = document.l10n.getAttributes(channelLabel);
    let channel = UpdateUtils.UpdateChannel;
    document.l10n.setAttributes(channelLabel, channelAttrs.id, { channel });
    if (
      /^release($|\-)/.test(channel) ||
      Services.sysinfo.getProperty("isPackagedApp")
    ) {
      channelLabel.hidden = true;
    }
  }

  if (AppConstants.IS_ESR) {
    document.getElementById("release").hidden = false;
  }

  let boxLogo = document.getElementById("leftBox");
  document.addEventListener("keydown", (e) => {
    if (e.shiftKey) { boxLogo.setAttribute("sajoumode", ""); }
  });
  document.addEventListener("keyup", (e) => {
    if (!e.shiftKey) { boxLogo.removeAttribute("sajoumode"); }
  });
}

init();
