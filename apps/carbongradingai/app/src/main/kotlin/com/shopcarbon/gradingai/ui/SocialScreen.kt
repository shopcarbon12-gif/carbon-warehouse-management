package com.shopcarbon.gradingai.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PlayCircle
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.shopcarbon.gradingai.App
import com.shopcarbon.gradingai.model.BestHour
import com.shopcarbon.gradingai.model.SocialPost
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter

private val ET: ZoneId = ZoneId.of("America/New_York")
private val DAY_FMT = DateTimeFormatter.ofPattern("EEE, MMM d")
private val TIME_FMT = DateTimeFormatter.ofPattern("h:mm a")
private val WHEN_FMT = DateTimeFormatter.ofPattern("EEE, MMM d · h:mm a")
private val DAYS = listOf("Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat")

/** Same words as CarbonWMS › CarbonCast › Calendar. */
private val STATUS = mapOf(
    "draft" to "Waiting for approval", "changes_requested" to "Changes requested", "approved" to "Approved",
    "publishing" to "Publishing", "published" to "Published", "partly_published" to "Partly published",
    "failed" to "Failed", "cancelled" to "Cancelled",
)
private val FORMAT = mapOf("image" to "Single image", "carousel" to "Carousel", "reel" to "Reel", "story" to "Story")
private val CHANNEL = mapOf("instagram" to "Instagram", "facebook" to "Facebook")
private val FILTERS = listOf("all" to "All", "waiting" to "Waiting", "approved" to "Approved", "out" to "Gone out")

private fun statusColor(s: String) = when (s) {
    "approved" -> Palette.ok
    "changes_requested", "partly_published" -> Palette.warn
    "failed" -> Palette.bad
    "publishing", "published" -> Palette.accent
    else -> Palette.muted
}

private fun et(iso: String?) = iso?.let { runCatching { Instant.parse(it).atZone(ET) }.getOrNull() }
private fun hourLabel(h: Int) = when { h == 0 -> "12 AM"; h < 12 -> "$h AM"; h == 12 -> "12 PM"; else -> "${h - 12} PM" }

private var lastFilter = "all"

/**
 * The Social tab: CarbonCast on the phone (owner, 2026-10-24 — no separate app;
 * it lives in CarbonTools). Every post by day, Eastern time; each one is
 * approved on its own — nothing goes out without that approval, and nothing
 * at all while the publishing switch is off.
 */
@Composable
fun SocialScreen(nav: Nav) {
    val app = App.get(LocalContext.current)
    val scope = rememberCoroutineScope()
    var posts by remember { mutableStateOf<List<SocialPost>?>(null) }
    var publishing by remember { mutableStateOf<Boolean?>(null) }
    var best by remember { mutableStateOf<List<BestHour>>(emptyList()) }
    var err by remember { mutableStateOf<String?>(null) }
    var askOn by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var filter by remember { mutableStateOf(lastFilter) }
    var reload by remember { mutableIntStateOf(0) }

    LaunchedEffect(reload) {
        err = null
        val from = LocalDate.now(ET).minusDays(7).atStartOfDay(ET).toInstant()
        val to = LocalDate.now(ET).plusDays(45).atStartOfDay(ET).toInstant()
        runCatching { app.api.socialPosts(from.toString(), to.toString()) }.onSuccess { posts = it }.onFailure { err = it.message; if (posts == null) posts = emptyList() }
        runCatching { app.api.socialSettings() }.onSuccess { publishing = it }
        runCatching { app.api.bestHours() }.onSuccess { best = it }
    }
    fun setPublishing(on: Boolean) = scope.launch {
        busy = true
        runCatching { app.api.setSocialPublishing(on) }.onSuccess { publishing = it }.onFailure { err = it.message }
        busy = false
    }

    Page(
        "Social", eyebrow = "CARBONCAST",
        actions = { GlassCircle(Icons.Filled.Refresh, "Refresh", { reload++ }) },
        tabs = { BottomTabs(Tab.Social) { onTab(nav, it) } },
    ) {
        Card(padding = 14.dp) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Column(Modifier.weight(1f)) {
                    Text(
                        when (publishing) { true -> "Publishing is ON"; false -> "Publishing is OFF"; null -> "Publishing" },
                        style = MaterialTheme.typography.titleMedium, color = if (publishing == true) Palette.ok else Palette.text,
                    )
                    Muted(if (publishing == true) "Approved posts go out at their time." else "Nothing goes out, even approved posts.")
                }
                Switch(
                    publishing == true, { if (it) askOn = true else setPublishing(false) }, enabled = publishing != null && !busy,
                    colors = SwitchDefaults.colors(checkedTrackColor = Palette.ok, checkedThumbColor = Color.White),
                )
            }
        }
        if (best.isNotEmpty()) {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Label("Best hour each day (Instagram, Eastern)")
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    for (b in best) Pill("${DAYS.getOrElse(b.weekday) { "?" }} ${hourLabel(b.hour)}")
                }
            }
        }
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            for ((id, label) in FILTERS) Pill(label, filled = filter == id) { filter = id; lastFilter = id }
        }
        err?.let { Notice(it, Palette.bad) }
        val all = posts
        val shown = all.orEmpty().filter {
            when (filter) {
                "waiting" -> it.status == "draft" || it.status == "changes_requested"
                "approved" -> it.status == "approved"
                "out" -> it.status in setOf("publishing", "published", "partly_published", "failed")
                else -> true
            }
        }
        when {
            all == null -> Muted("Loading…")
            shown.isEmpty() -> Muted("No posts here.")
            else -> {
                val waiting = all.count { it.status == "draft" || it.status == "changes_requested" }
                if (waiting > 0) Muted("$waiting post${if (waiting == 1) "" else "s"} waiting for approval")
                val byDay = shown.sortedBy { it.scheduledAt ?: "9" }.groupBy { et(it.scheduledAt)?.toLocalDate() }
                for ((day, list) in byDay) {
                    Group(header = day?.format(DAY_FMT) ?: "No time set") {
                        list.forEachIndexed { i, p ->
                            ListRow(
                                p.title.ifBlank { FORMAT[p.format] ?: p.format },
                                subtitle = listOfNotNull(et(p.scheduledAt)?.format(TIME_FMT), FORMAT[p.format], p.targets.joinToString(" + ") { CHANNEL[it.provider] ?: it.provider }.ifBlank { null })
                                    .joinToString(" · "),
                                divider = i > 0,
                                leading = { NetImage(p.thumb, Modifier.size(52.dp), crop = true, maxPx = 240, corner = 10.dp) },
                                trailing = { Badge(STATUS[p.status] ?: p.status, statusColor(p.status), solid = p.status == "approved") },
                                onClick = { nav.go(Screen.SocialPost(p)) },
                            )
                        }
                    }
                }
            }
        }
    }

    if (askOn) AlertDialog(
        onDismissRequest = { askOn = false },
        title = { Text("Turn publishing on?") },
        text = { Text("Approved posts will go out to Instagram and Facebook at their time. Posts waiting for approval stay put.") },
        confirmButton = { TextButton(onClick = { askOn = false; setPublishing(true) }) { Text("Turn on") } },
        dismissButton = { TextButton(onClick = { askOn = false }) { Text("Not now") } },
    )
}

/** One post: its pictures or video, caption, product tags and channels — approve it, ask for changes, or cancel it. */
@Composable
fun SocialPostScreen(nav: Nav, post: SocialPost) {
    val ctx = LocalContext.current
    val app = App.get(ctx)
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var err by remember { mutableStateOf<String?>(null) }
    var ask by remember { mutableStateOf<String?>(null) }
    var note by remember { mutableStateOf("") }
    val whenText = et(post.scheduledAt)?.format(WHEN_FMT) ?: "No time set"
    val channels = post.targets.joinToString(" + ") { CHANNEL[it.provider] ?: it.provider }

    fun decide(action: String, withNote: String? = null) = scope.launch {
        busy = true; err = null
        runCatching { app.api.socialDecide(post.id, action, withNote) }
            .onSuccess { nav.replace(Screen.SocialPost(it)) }
            .onFailure { err = it.message }
        busy = false
    }
    fun open(url: String) = runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }

    Page(post.title.ifBlank { "Post" }, onBack = { nav.back() }, largeTitle = false, tabs = { BottomTabs(Tab.Social) { onTab(nav, it) } }) {
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            for (m in post.media.sortedBy { it.position }) {
                val w = if (post.media.size == 1) Modifier.fillMaxWidth() else Modifier.width(280.dp)
                if (m.kind == "video") {
                    Box(w.clickable { open(m.url) }, contentAlignment = Alignment.Center) {
                        NetImage(m.coverUrl, Modifier.fillMaxWidth(), maxPx = 1200, corner = 18.dp, fitAspect = 9f / 16f)
                        Icon(Icons.Filled.PlayCircle, "Play the video", tint = Color.White, modifier = Modifier.size(64.dp))
                    }
                } else NetImage(m.url, w, maxPx = 1400, corner = 18.dp, fitAspect = 0.8f)
            }
        }
        Card(padding = 14.dp) {
            KeyValue("Goes out", whenText)
            KeyValue("Format", FORMAT[post.format] ?: post.format)
            KeyValue("Channels", channels.ifBlank { "None" })
            KeyValue("Status", STATUS[post.status] ?: post.status, statusColor(post.status))
            post.approvedBy?.let { KeyValue("Approved by", it) }
        }
        for (t in post.targets) {
            t.error?.let { Notice("${CHANNEL[t.provider] ?: t.provider}: $it", Palette.bad) }
            t.permalink?.let { link -> Secondary("Open on ${CHANNEL[t.provider] ?: t.provider}") { open(link) } }
        }
        post.note?.let { Notice("Note: $it", Palette.warn) }
        Group(header = "Caption") {
            Text(post.caption.ifBlank { "No caption." }, style = MaterialTheme.typography.bodyLarge, color = Palette.text, modifier = Modifier.padding(16.dp))
            if (post.hashtags.isNotEmpty()) Text(
                post.hashtags.joinToString(" ") { if (it.startsWith("#")) it else "#$it" },
                style = MaterialTheme.typography.bodyMedium, color = Palette.accent, modifier = Modifier.padding(start = 16.dp, end = 16.dp, bottom = 16.dp),
            )
        }
        if (post.tags.isNotEmpty()) Group(header = "Product tags (${post.tags.size})") {
            post.tags.sortedBy { it.mediaPosition }.forEachIndexed { i, t ->
                ListRow(t.label, subtitle = if (post.media.size > 1) "Picture ${t.mediaPosition + 1}" else null, divider = i > 0)
            }
        }
        err?.let { Notice(it, Palette.bad) }
        if (!post.locked) {
            when (post.status) {
                "draft", "changes_requested" -> {
                    Primary(if (busy) "Saving…" else "Approve", enabled = !busy) { ask = "approve" }
                    Secondary("Ask for changes", enabled = !busy) { note = post.note.orEmpty(); ask = "request_changes" }
                }
                "approved" -> Secondary("Take back approval", enabled = !busy) { decide("reopen") }
                "cancelled", "failed" -> Secondary("Reopen", enabled = !busy) { decide("reopen") }
            }
            if (post.status != "cancelled") Text(
                "Cancel this post", style = MaterialTheme.typography.bodyMedium, color = Palette.bad,
                modifier = Modifier.fillMaxWidth().clickable(enabled = !busy) { ask = "cancel" }.padding(vertical = 10.dp),
            )
        }
    }

    when (ask) {
        "approve" -> AlertDialog(
            onDismissRequest = { ask = null },
            title = { Text("Approve this post?") },
            text = { Text("It goes out $whenText (Eastern) to ${channels.ifBlank { "its channels" }} — only while publishing is on.") },
            confirmButton = { TextButton(onClick = { ask = null; decide("approve") }) { Text("Approve") } },
            dismissButton = { TextButton(onClick = { ask = null }) { Text("Not yet") } },
        )
        "request_changes" -> AlertDialog(
            onDismissRequest = { ask = null },
            title = { Text("What should change?") },
            text = { OutlinedTextField(note, { note = it }, Modifier.fillMaxWidth(), placeholder = { Text("Note for the post") }, minLines = 3) },
            confirmButton = { TextButton(onClick = { ask = null; decide("request_changes", note.trim()) }) { Text("Send") } },
            dismissButton = { TextButton(onClick = { ask = null }) { Text("Back") } },
        )
        "cancel" -> AlertDialog(
            onDismissRequest = { ask = null },
            title = { Text("Cancel this post?") },
            text = { Text("It will not go out. You can reopen it later.") },
            confirmButton = { TextButton(onClick = { ask = null; decide("cancel") }) { Text("Cancel post") } },
            dismissButton = { TextButton(onClick = { ask = null }) { Text("Keep it") } },
        )
    }
}
