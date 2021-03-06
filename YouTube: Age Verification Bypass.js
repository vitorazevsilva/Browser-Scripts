// ==UserScript==
// @name         YouTube: Age Verification Bypass
// @namespace    https://greasyfork.org/users/221926
// @version      1.9.4
// @description  watch restricted videos without having to log in
// @include      https://www.youtube.com/*
// @connect      googlevideo.com
// @grant        GM.xmlHttpRequest
// @require      https://unpkg.com/@ffmpeg/ffmpeg@0.7.0/dist/ffmpeg.min.js
// @run-at       document-start
// ==/UserScript==
 
(function () {
  'use strict'
 
  const NEW_LAYOUT_PLAYER_CONTAINER_ID = 'player-container'
  const NEW_LAYOUT_ERROR_SCREEN_ID = 'error-screen'
  const OLD_LAYOUT_SIDEBAR_MODULES_ID = 'watch7-sidebar-modules'
  const NEW_LAYOUT_RELATED_ITEM_TEMPLATE = rv => `<a href="/watch?v=${rv.id}" style="text-decoration:none;display:block;margin-bottom:8px;" title="${rv.title}"><table style="border-collapse:collapse"><td style="position:relative;padding:0"><img src="${rv.iurlmq}" style="width:168px;height:94px;display:block;margin-right:8px"><span style="position:absolute;bottom:0;right:8px;margin:4px;color:var(--ytd-thumbnail-badge_-_color,#fff);background-color:var(--ytd-thumbnail-badge_-_background-color,rgba(0,0,0,.8));padding:2px 4px;border-radius:2px;letter-spacing:.5px;font-size:1.2rem;font-weight:500;line-height:1.2rem">${rv.duration}</span></td><td style="vertical-align:top;"><span style="display:block;margin:0 0 4px 0;max-height:3.2rem;overflow:hidden;font-size:1.4rem;font-weight:500;line-height:1.6rem;color:var(--yt-primary-text-color,rgba(255,255,255,0.88));">${rv.title}</span><div style="color:var(--ytd-metadata-line-color,var(--yt-spec-text-secondary,#aaa));font-size:1.3rem;font-weight:400;line-height:1.8rem;">${rv.author}<br>${rv.short_view_count_text}</div></td></table></a>`
  const OLD_LAYOUT_RELATED_ITEM_TEMPLATE = rv => `<div class="video-list-item related-list-item show-video-time related-list-item-compact-video"><div class="content-wrapper"><a href="/watch?v=${rv.id}" class="content-link spf-link yt-uix-sessionlink spf-link"><span dir="ltr" class="title">${rv.title}</span><span class="stat attribution"><span class="">${rv.author}</span></span><span class="stat view-count">${rv.short_view_count_text}</span></a></div><div class="thumb-wrapper"><a href="/watch?v=${rv.id}" class="thumb-link spf-link yt-uix-sessionlink" tabindex="-1" rel=" spf-prefetch nofollow" aria-hidden="true"><span class="yt-uix-simple-thumb-wrap yt-uix-simple-thumb-related"><img alt="" src="${rv.iurlmq}" style="top: 0px" aria-hidden="true" width="168" height="94"><span class="video-time">${rv.duration}</span></span></a></div></div>`
 
  let player = null
  let related = null
  let currentVideoId = null
 
  // General
  function escapeHTML (str) {
    return document.createElement('div').appendChild(document.createTextNode(str)).parentNode.innerHTML
  }
 
  async function download (url, onprogress) {
    return new Promise((resolve, reject) => {
      GM.xmlHttpRequest({
        method: 'GET',
        url,
        onprogress,
        onload: res => resolve(res.response),
        responseType: 'arraybuffer'
      })
    })
  }
 
  async function downloadAll (urls, onprogress) {
    const progress = {}
    const result = {}
    await Promise.all(Object.entries(urls).map(async ([k, url]) => {
      result[k] = await download(url, event => {
        progress[k] = event
        onprogress({
          loaded: Object.values(progress).reduce((acc, curr) => acc + curr.loaded, 0),
          total: Object.values(progress).reduce((acc, curr) => acc + curr.total, 0)
        })
      })
    }))
    return result
  }
 
  async function ffmpegMerge ({ video, audio }) {
    const worker = FFmpeg.createWorker({ logger: ({ message }) => console.log(message) })
    await worker.load()
    await worker.write('video', video)
    await worker.write('audio', audio)
    await worker.run('-i video -i audio -c copy output.webm')
    const { data } = await worker.read('output.webm')
    await worker.terminate()
    return data
  }
 
  // DOM
  function removeNode (n) {
    if (n != null && n.parentNode != null) { n.parentNode.removeChild(n) }
  }
 
  function asyncQuerySelector (query, token = {}, document = window.document) {
    return new Promise((resolve, reject) => {
      const ival = setInterval(function () {
        const el = document.querySelector(query)
        if (el != null) { clearInterval(ival); resolve(el) }
      }, 100)
      token.cancel = () => { clearInterval(ival); reject() }
    })
  }
 
  // YouTube
  function getVideoId () {
    return (location.pathname.match(/^\/embed\/([a-zA-Z0-9_-]+)$/) || [])[1] ||
      new URLSearchParams(location.search).get('v')
  }
 
  function getPlaylistId () {
    return new URLSearchParams(location.search).get('list')
  }
 
  function getVideoStart () {
    const t = new URLSearchParams(location.search).get('t') || 0
    if (!isNaN(t)) { return +t }
    const multipliers = { h: 3600, m: 60, s: 1 }
    return t.match(/[0-9]+[a-z]/g)
      .map(str => str.slice(0, -1) * multipliers[str.slice(-1)])
      .reduce((a, b) => a + b)
  }
 
  let jsPlayerPromise
  async function getFormatUrl (format) {
    if (format.url) return format.url
    try {
      // https://github.com/ytdl-org/youtube-dl
      const cipher = new URLSearchParams(format.signatureCipher)
      if (cipher.get('sig')) return `${cipher.get('url')}&signature=${cipher.get('sig')}`
      if (jsPlayerPromise == null) jsPlayerPromise = fetch('https://www.youtube.com' + JSON.parse(document.body.innerHTML.match(/"[^"]+player_ias[^"]+\/base.js"/)[0])).then(res => res.text())
      const jsPlayerString = await jsPlayerPromise
      const functionName = [
        /\b[cs]\s*&&\s*[adf]\.set\([^,]+\s*,\s*encodeURIComponent\s*\(\s*([a-zA-Z0-9$]+)\(/,
        /\b[a-zA-Z0-9]+\s*&&\s*[a-zA-Z0-9]+\.set\([^,]+\s*,\s*encodeURIComponent\s*\(\s*([a-zA-Z0-9$]+)\(/,
        /\bm=([a-zA-Z0-9$]{2})\(decodeURIComponent\(h\.s\)\)/,
        /\bc&&\(c=([a-zA-Z0-9$]{2})\(decodeURIComponent\(c\)\)/,
        /(?:\b|[^a-zA-Z0-9$])([a-zA-Z0-9$]{2})\s*=\s*function\(\s*a\s*\)\s*{\s*a\s*=\s*a\.split\(\s*""\s*\);[a-zA-Z0-9$]{2}\.[a-zA-Z0-9$]{2}\(a,\d+\)/,
        /(?:\b|[^a-zA-Z0-9$])([a-zA-Z0-9$]{2})\s*=\s*function\(\s*a\s*\)\s*{\s*a\s*=\s*a\.split\(\s*""\s*\)/,
        /([a-zA-Z0-9$]+)\s*=\s*function\(\s*a\s*\)\s*{\s*a\s*=\s*a\.split\(\s*""\s*\)/
      ].reduce((prev, regex) => prev || (jsPlayerString.match(regex) || [])[1], null)
      const functionString = jsPlayerString.match(new RegExp(`${functionName}=(function\\([^\\)]+\\){.*?});`))[1]
      ;(1, eval)(jsPlayerString.match(new RegExp(`${functionString.match(/;([a-zA-Z0-9$]+)\./)[1]}={[\\s\\S]*?};`))[0]) // eslint-disable-line no-eval
      return `${cipher.get('url')}&${cipher.get('sp') || 'signature'}=${eval(`(${functionString})(${JSON.stringify(cipher.get('s'))})`)}` // eslint-disable-line no-eval
    } catch (e) {
      console.error(e)
    }
  }
 
  async function getFormats (videoId) {
    const videoInfo = await fetch('https://www.youtube.com/get_video_info?asv=3&video_id=' + videoId + '&eurl=https://youtube.googleapis.com/v/' + videoId).then(res => res.text())
    const streamingData = JSON.parse(new URLSearchParams(videoInfo).get('player_response')).streamingData || {}
    const formats = (await Promise.all((streamingData.formats || []).map(async f => ({ ...f, url: await getFormatUrl(f), isAdaptive: false })))).filter(f => f.url)
    const adaptiveFormats = (await Promise.all((streamingData.adaptiveFormats || []).map(async f => ({ ...f, url: await getFormatUrl(f), isAdaptive: true })))).filter(f => f.url)
    const adaptiveAudioFormat = adaptiveFormats.filter(f => f.mimeType.startsWith('audio/webm')).sort((a, b) => b.bitrate - a.bitrate)[0]
    const adaptiveVideoFormats = adaptiveFormats.filter(f => f.mimeType.startsWith('video/webm') && f.type !== 'FORMAT_STREAM_TYPE_OTF').map(f => ({ ...f, audioFormat: adaptiveAudioFormat }))
    if (adaptiveAudioFormat != null) formats.push(...adaptiveVideoFormats.reverse())
    return formats
  }
 
  function isInitialVideoAndAgeRestricted (videoId = getVideoId()) {
    // https://greasyfork.org/scripts/371261
    return window.ytInitialPlayerResponse != null &&
      typeof window.ytInitialPlayerResponse.playabilityStatus.desktopLegacyAgeGateReason != 'undefined' &&
      window.ytInitialPlayerResponse.playabilityStatus.desktopLegacyAgeGateReason &&
      window.ytInitialPlayerResponse.videoDetails.videoId === videoId
  }
 
  // Script
  const newLayout = {
    restrictedVideoIds: [],
    fallbackLink: (() => {
      const span = document.createElement('span')
      span.innerText = 'Click here if the video is age restricted'
      span.style = 'font-size:1.6rem;margin-top:1rem;color:#fff;cursor:pointer;text-decoration:underline'
      span.onclick = () => { reset(); newLayout.unrestrict() }
      return span
    })(),
    checkDOMAndPrepare () {
      let signInButton = null
      const errorScreenInfoDiv = document.querySelector('#error-screen #info')
      if (errorScreenInfoDiv != null) {
        // signInButton
        signInButton = errorScreenInfoDiv.getElementsByTagName('yt-button-renderer')[0]
        removeNode(signInButton) // avoids false positives
        // fallbackLink
        removeNode(newLayout.fallbackLink)
        errorScreenInfoDiv.appendChild(newLayout.fallbackLink)
      }
      return signInButton != null
    },
    checkAndPrepare (videoId = getVideoId()) {
      const DOMCheck = newLayout.checkDOMAndPrepare()
      const inArray = newLayout.restrictedVideoIds.includes(videoId) // signInButton may not have been recreated while navigating back/forward, check array too
      if (DOMCheck || inArray || isInitialVideoAndAgeRestricted(videoId)) {
        if (!inArray) { newLayout.restrictedVideoIds.push(videoId) }
        return true
      }
      return false
    },
    unrestrict (videoId = getVideoId(), options = {}) {
      const oldPlayer = document.getElementById(NEW_LAYOUT_PLAYER_CONTAINER_ID)
      // pause video (useful when coming back from an unrestricted video)
      document.querySelectorAll('video').forEach(el => el.pause())
      // player
      createPlayer(videoId, oldPlayer.parentNode)
      player.id = oldPlayer.id
      player.className = oldPlayer.className
      // related
      const rs = document.getElementById('related-skeleton')
      if (rs != null && rs.parentNode != null) {
        rs.style.display = 'none'
        showRelatedVideos(videoId, rs.parentNode, NEW_LAYOUT_RELATED_ITEM_TEMPLATE)
      }
      // remove/hide blocking elements
      document.querySelectorAll('[player-unavailable]').forEach(el => el.removeAttribute('player-unavailable'))
      removeNode(document.querySelector('#player.skeleton'))
      oldPlayer.style.display = 'none';
      (options.errorScreen || document.getElementById(NEW_LAYOUT_ERROR_SCREEN_ID)).style.display = 'none'
      // cancelPlaylistVideoSkip
      newLayout.cancelPlaylistVideoSkip(videoId)
    },
    cancelPlaylistVideoSkip (videoId) {
      if (getPlaylistId() == null) return
      const manager = document.querySelector('yt-playlist-manager')
      if (!manager || !manager.cancelVideoSkip) return // greasemonkey
      manager.cancelVideoSkip()
      if (manager.skipAgeUserScript !== getPlaylistId()) { // cancelVideoSkip does not seem to work on the first video
        manager.skipAgeUserScript = getPlaylistId()
        const rollback = () => {
          killRollback()
          asyncQuerySelector(`ytd-playlist-panel-video-renderer a[href*="${videoId}"]`).then(e => e.click())
        }
        const killRollback = () => {
          removeEventListener('yt-navigate-finish', rollback)
          removeEventListener('click', killRollback)
        }
        addEventListener('yt-navigate-finish', rollback)
        setTimeout(() => killRollback, 10 * 1000) // if no redirect after 10 seconds, yt-navigate was probably not due to the video being restricted
        addEventListener('click', killRollback)
      }
    },
    checkAndUnrestrict (videoId, options) {
      if (newLayout.checkAndPrepare(videoId)) { newLayout.unrestrict(videoId, options) }
    },
    reset () {
      (document.getElementById(NEW_LAYOUT_PLAYER_CONTAINER_ID) || { style: {} }).style.display = '';
      (document.getElementById(NEW_LAYOUT_ERROR_SCREEN_ID) || { style: {} }).style.display = ''
    }
  }
 
  const oldLayout = {
    check () {
      return document.getElementById('watch7-player-age-gate-content') != null
    },
    unrestrict (videoId = getVideoId(), options = {}) {
      const playerParentNode = document.getElementById('player-unavailable')
      playerParentNode.innerHTML = ''
      createPlayer(videoId, playerParentNode)
      showRelatedVideos(videoId, options.sidebarModulesContainer || document.getElementById(OLD_LAYOUT_SIDEBAR_MODULES_ID), OLD_LAYOUT_RELATED_ITEM_TEMPLATE).then(() => { related.className = 'video-list' })
    },
    checkAndUnrestrict (videoId, options) {
      if (oldLayout.check()) { oldLayout.unrestrict(videoId, options) }
    },
    reset () {}
  }
 
  function createPlayer (videoId, parentNode) {
    player = document.createElement('iframe')
    player.onload = () => checkAndUnrestrictEmbed(player.contentDocument) // greasemonkey
    player.src = `https://www.youtube.com/embed/${videoId}?start=${getVideoStart()}&autoplay=1`
    player.style = 'border:0;width:100%;height:100%'
    player.setAttribute('allowfullscreen', '') // firefox (https://greasyfork.org/en/scripts/375525/discussions/43480)
    parentNode.appendChild(player)
  }
 
  async function showRelatedVideos (videoId, parentNode, itemTemplate) {
    let innerHTML = ''
    const videoInfo = await fetch('https://www.youtube.com/get_video_info?asv=3&video_id=' + videoId).then(res => res.text())
    if (videoId !== getVideoId()) { return }
    new URLSearchParams(videoInfo).get('rvs').split(',').forEach(str => {
      const rv = new URLSearchParams(str)
      if (rv.has('title')) {
        innerHTML += itemTemplate({
          id: rv.get('id'),
          author: escapeHTML(rv.get('author')),
          title: escapeHTML(rv.get('title')),
          duration: Math.floor(rv.get('length_seconds') / 60) + ':' + ('0' + (rv.get('length_seconds') % 60)).substr(-2),
          iurlmq: rv.get('iurlmq'),
          short_view_count_text: rv.get('short_view_count_text')
        })
      }
    })
    related = document.createElement('div')
    related.innerHTML = innerHTML
    parentNode.appendChild(related)
  }
 
  function reset () {
    removeNode(player)
    removeNode(related)
    newLayout.reset()
    oldLayout.reset()
  }
 
  function checkAndUnrestrict () {
    const videoId = getVideoId()
    if (videoId === currentVideoId) { return }
    currentVideoId = videoId
    reset() // useful when coming back from a restricted video
    if (videoId == null) { return }
 
    const newLayoutToken = { cancel: () => {} }
    const oldLayoutToken = { cancel: () => {} }
    asyncQuerySelector('#' + NEW_LAYOUT_ERROR_SCREEN_ID, newLayoutToken).then(errorScreen => {
      oldLayoutToken.cancel()
      if (videoId !== currentVideoId) { return }
      newLayout.checkAndUnrestrict(videoId, { errorScreen })
    }).catch(() => {})
    asyncQuerySelector('#' + OLD_LAYOUT_SIDEBAR_MODULES_ID, oldLayoutToken).then(sidebarModulesContainer => {
      newLayoutToken.cancel()
      if (videoId !== currentVideoId) { return }
      oldLayout.checkAndUnrestrict(videoId, { sidebarModulesContainer })
    }).catch(() => {})
  }
 
  async function checkAndUnrestrictEmbed (document = window.document) {
    if (document.skipAgeUserScript) return
    document.skipAgeUserScript = true
    await asyncQuerySelector('.ytp-error-content, .playing-mode .html5-main-video[src]', {}, document)
    if (document.querySelector('.ytp-error-content') == null) return
    // load formats
    const banner = document.createElement('div')
    banner.innerText = 'Checking for sources...'
    banner.style = 'background-color:purple;color:white;padding:1em;position:absolute;z-index:99999;top:0;left:0;width:100%'
    document.body.prepend(banner)
    const formats = await getFormats(getVideoId())
    if (formats.length === 0) {
      banner.style.backgroundColor = 'red'
      banner.innerText = 'Could not find any source !'
      return
    }
    removeNode(banner)
    // create buttons
    document.body.outerHTML = '<body style="background-color:black;display:flex;align-items:center;justify-content:center;text-align:center"><div id="container"></div></body>'
    formats.forEach(f => {
      const button = document.createElement('button')
      button.innerText = f.qualityLabel
      button.style = 'padding:1rem;margin:1rem;border:none;'
      if (f.isAdaptive) button.style = 'padding:1rem;margin:1rem;border:none;background:purple;color:white'
      button.onclick = () => createPlayer(f)
      document.getElementById('container').appendChild(button)
    })
    // create player
    const createPlayer = async format => {
      let url = format.url
      if (format.isAdaptive) {
        document.body.innerHTML = '<div style="width:90%"><h1>Downloading...</h1><div style="height:16px;margin:24px 0;border:solid purple"><div id="progress" style="height:100%;background:purple;width:0px"></div></div>If this takes too long, reload the page and <b>select one of the gray options.</b></div>'
        const files = await downloadAll({ video: format.url, audio: format.audioFormat.url }, event => { document.getElementById('progress').style.width = `${100 * event.loaded / Math.max(event.total, 1)}%` })
        url = URL.createObjectURL(new Blob([await ffmpegMerge(files)]))
      }
      document.body.innerHTML = `<video controls autoplay height="100%" width="100%"><source src="${url}"></video>`
    }
  }
 
  function overrideEmbeddedPlayerResponse () {
    if (!('unsafeWindow' in window)) return
    if ('ytcfg' in unsafeWindow) {
      if (unsafeWindow.ytcfg.get('PLAYER_VARS') && JSON.parse(unsafeWindow.ytcfg.get('PLAYER_VARS').embedded_player_response).playabilityStatus.status !== 'UNPLAYABLE') return
      // "Inject Mode: Instant" would probably be a better solution (https://github.com/Tampermonkey/tampermonkey/issues/211#issuecomment-317116595)
      const params = new URLSearchParams(location.search)
      const reloadCount = +params.get('reload-count')
      if (reloadCount >= 10 || isNaN(reloadCount)) return
      params.set('reload-count', reloadCount + 1)
      location.search = params.toString()
      return
    }
    let successful = false
    // ytcfg
    let ytcfg
    Object.defineProperty(unsafeWindow, 'ytcfg', {
      set (value) {
        ytcfg = value
        ytcfg._set = ytcfg.set
        ytcfg.set = (...args) => {
          try {
            if (JSON.parse(args[0].PLAYER_VARS.embedded_player_response).playabilityStatus.status === 'UNPLAYABLE') {
              const videoId = getVideoId()
              var xhr = new XMLHttpRequest()
              xhr.open('GET', 'https://www.youtube.com/get_video_info?asv=3&video_id=' + videoId + '&eurl=https://youtube.googleapis.com/v/' + videoId, false)
              xhr.send()
              const player_response = new URLSearchParams(xhr.response).get('player_response')
              successful = JSON.parse(player_response).playabilityStatus.status === 'OK'
              if (successful) args[0].PLAYER_VARS.embedded_player_response = player_response
            }
          } catch (e) { console.error(e) }
          ytcfg._set(...args)
        }
      },
      get () { return ytcfg }
    })
    // XMLHttpRequest
    const _XMLHttpRequest = XMLHttpRequest
    unsafeWindow.XMLHttpRequest = class extends _XMLHttpRequest {
      open (...args) { this.url = args[1]; super.open(...args) }
      get response () {
        return successful && this.url.includes('/youtubei/v1/player?key=')
          ? ytcfg.get('PLAYER_VARS').embedded_player_response
          : super.response
      }
    }
  }
 
  // new layout; chrome: prevents redirection to the last unrestricted video or /watch?v=undefined when leaving fullscreen; non-theater: prevents the parent nodes of the iframe from being hidden
  addEventListener('fullscreenchange', (ev) => { if (newLayout.restrictedVideoIds.includes(getVideoId())) { ev.stopImmediatePropagation() } }, true)
 
  if (location.pathname.startsWith('/embed/')) {
    // embed (https://support.google.com/youtube/answer/2802167#:~:text=embedded%20player%2C%20will%20be%20redirected%20to%20YouTube%2C%20where%20they%20will%20only%20be%20able%20to%20view%20the%20content%20when%20signed-in)
    checkAndUnrestrictEmbed()
    overrideEmbeddedPlayerResponse() // I put it here instead of in checkAndUnrestrictEmbed because it does not seem to work with GreaseMonkey and I don't want to deal with the document workaround.
  } else {
    // new layout; getEventListeners(window)
    addEventListener('yt-navigate-start', reset)
    addEventListener('yt-navigate-finish', checkAndUnrestrict)
    // old layout; getEventListeners(window)
    addEventListener('spfdone', checkAndUnrestrict)
  }
})()
