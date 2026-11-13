/**
 * mobile/anim.js —— 手机版桌宠立绘动画（1:1 复刻电脑端 anim.ts 的核心观感）
 *
 * 只做视觉：呼吸浮动 + 眨眼 + 说话嘴动（小幅度噏合）。
 * 不碰业务、不发请求、不依赖任何框架；纯 canvas 绘制，接口只有 start / stop / talkFor。
 * 坐标与电脑端一致（横版立绘 1696×1504，画布 480×426，源图坐标 × sx/sy）。
 */
(function () {
  'use strict'

  var CW = 480
  var CH = 426
  var SRC_W = 1696
  var SRC_H = 1504
  var SX = CW / SRC_W
  var SY = CH / SRC_H

  // 横版立绘实测五官（源图坐标）——与电脑端 anim.ts 一致
  var EYE_L = { x: 730, y: 420, r: 68 }
  var EYE_R = { x: 870, y: 422, r: 68 }
  var MOUTH = { x: 779, y: 525, rw: 26, rh: 18 }

  function createAnimator(canvas, imgSrc) {
    var ctx = canvas.getContext('2d')
    var img = new Image()
    var loaded = false
    var raf = 0
    var running = false
    var last = 0

    // 眨眼：间隔缩短、闭眼稍长，手机小尺寸下也能看见
    var blinkT = 0
    var blinkClosed = false
    var blinkGap = 2400 + Math.random() * 1600

    // 说话嘴动
    var talkUntil = 0

    function now() { return (window.performance && performance.now) ? performance.now() : Date.now() }

    function drawEye(c, closed) {
      if (!closed) return
      var p = { x: c.x * SX, y: c.y * SY }
      var r = c.r * SX
      ctx.fillStyle = '#F9EDE7'
      ctx.beginPath()
      ctx.ellipse(p.x, p.y, r * 1.15, r * 0.9, 0, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = '#3a2a24'
      ctx.lineWidth = 3
      ctx.beginPath()
      ctx.arc(p.x, p.y, r * 0.8, 0.15 * Math.PI, 0.85 * Math.PI)
      ctx.stroke()
    }

    function drawMouth(open) {
      if (open) return // 张嘴帧：露立绘的嘴
      var p = { x: MOUTH.x * SX, y: MOUTH.y * SY }
      var rw = MOUTH.rw * SX * 1.7
      var rh = MOUTH.rh * SY * 1.9
      ctx.fillStyle = '#FDF6F0'
      ctx.beginPath()
      ctx.ellipse(p.x, p.y, rw, rh, 0, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = '#C56E6A'
      ctx.lineWidth = 1.4
      ctx.beginPath()
      ctx.moveTo(p.x - rw * 0.5, p.y + rh * 0.03)
      ctx.quadraticCurveTo(p.x, p.y + rh * 0.3, p.x + rw * 0.5, p.y + rh * 0.03)
      ctx.stroke()
    }

    function drawFrame(t) {
      var dt = last ? Math.max(0, Math.min(50, t - last)) : 16.7
      last = t
      ctx.clearRect(0, 0, CW, CH)
      if (!loaded) {
        raf = requestAnimationFrame(drawFrame)
        return
      }

      // 呼吸浮动 + 轻微摇摆（手机端 CSS 会把画布缩到 ~118px 宽，
      // 原来的 ±2.2px 缩放后只剩 0.5px，肉眼以为静止；这里放大到缩放后约 2px）
      var bob = Math.sin(t / 1200) * 7
      var sway = Math.sin(t / 2100) * 0.012
      var breathe = 1 + Math.sin(t / 1400) * 0.012

      ctx.save()
      try {
        ctx.translate(CW / 2, CH / 2 + bob)
        ctx.rotate(sway)
        ctx.scale(breathe, breathe)
        ctx.translate(-CW / 2, -CH / 2)
        ctx.drawImage(img, 0, 0, SRC_W, SRC_H, 0, 0, CW, CH)

        // 眨眼：闭眼时画眼睑
        blinkT += dt
        if (!blinkClosed && blinkT > blinkGap) { blinkClosed = true; blinkT = 0 }
        if (blinkClosed && blinkT > 170) {
          blinkClosed = false
          blinkT = 0
          blinkGap = 2400 + Math.random() * 1600
        }
        if (blinkClosed) { drawEye(EYE_L, true); drawEye(EYE_R, true) }

        // 说话嘴动（小幅度噏合）
        if (t < talkUntil) drawMouth(Math.sin(t / 90) > 0)
      } finally {
        ctx.restore()
      }
      raf = requestAnimationFrame(drawFrame)
    }

    function start() {
      if (running) return
      running = true
      if (!img.src) {
        img.onload = function () { loaded = true }
        img.onerror = function () { loaded = false }
        img.src = imgSrc
      } else if (img.complete && img.naturalWidth) {
        loaded = true
      }
      last = 0
      raf = requestAnimationFrame(drawFrame)
    }

    function stop() {
      running = false
      if (raf) { try { cancelAnimationFrame(raf) } catch (e) { } }
      raf = 0
    }

    /** 说话时让嘴动起来（ms 为预计说话时长） */
    function talkFor(ms) {
      var d = Number(ms) || 0
      if (d <= 0) return
      talkUntil = now() + d
    }

    return { start: start, stop: stop, talkFor: talkFor, isLoaded: function () { return loaded } }
  }

  window.createWhaleAnimator = createAnimator
})()
