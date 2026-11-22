require('dotenv').config();
const http = require('http');
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelType,
  MessageFlags
} = require('discord.js');
const GasClient = require('./gasClient');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;
const PORT = process.env.PORT || 3000;

if (!TOKEN || !CLIENT_ID || !GAS_WEB_APP_URL) {
  console.error('❌ 環境変数 DISCORD_TOKEN / CLIENT_ID / GAS_WEB_APP_URL を確認してください。');
  process.exit(1);
}

const gas = new GasClient(GAS_WEB_APP_URL);
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

function formatJst(isoOrDate) {
  if (!isoOrDate) return '未記録';
  const d = new Date(isoOrDate);
  if (isNaN(d.getTime())) return String(isoOrDate);
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(d);
}

function formatDuration(minutes) {
  const mins = Math.max(0, Number(minutes) || 0);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}時間${m}分` : `${m}分`;
}

function parseJstDateInput(inputStr) {
  if (!inputStr) return null;
  const trimmed = inputStr.trim();
  const normalized = trimmed.replace(/\//g, '-');
  if (/^\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}$/.test(normalized)) {
    const [datePart, timePart] = normalized.split(/\s+/);
    const [hh, mm] = timePart.split(':').map(n => n.padStart(2, '0'));
    const isoWithOffset = `${datePart}T${hh}:${mm}:00+09:00`;
    const d = new Date(isoWithOffset);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(normalized);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function isAdminMember(interaction) {
  if (!interaction.memberPermissions) return false;
  return (
    interaction.memberPermissions.has(PermissionFlagsBits.Administrator) ||
    interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)
  );
}

function summarizeLogs(logs) {
  const completed = logs.filter(l => l.status === 'COMPLETED' || l.end_time);
  const byUser = new Map();

  let totalMinutes = 0;
  let totalCases = 0;

  for (const row of completed) {
    const uid = String(row.user_id);
    const mins = Number(row.duration_minutes) || 0;
    const cases = Number(row.cases_count) || 0;
    totalMinutes += mins;
    totalCases += cases;

    if (!byUser.has(uid)) {
      byUser.set(uid, {
        userId: uid,
        username: row.username || '不明なユーザー',
        shifts: 0,
        minutes: 0,
        cases: 0
      });
    }
    const entry = byUser.get(uid);
    entry.shifts += 1;
    entry.minutes += mins;
    entry.cases += cases;
    if (row.username) entry.username = row.username;
  }

  const ranking = Array.from(byUser.values()).sort((a, b) => b.minutes - a.minutes);
  return {
    shiftCount: completed.length,
    totalMinutes,
    totalCases,
    ranking
  };
}

const commands = [
  new SlashCommandBuilder()
    .setName('panel')
    .setDescription('勤怠パネルを設置します。オプションでログ送信先チャンネルを指定可能。')
    .addChannelOption(opt =>
      opt
        .setName('log_channel')
        .setDescription('勤務終了ログを送信するチャンネル（未指定の場合はこのチャンネル）')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('status')
    .setDescription('自分の勤務状態を確認します'),

  new SlashCommandBuilder()
    .setName('monthly_report')
    .setDescription('今すぐ月次集計を出力します（管理者専用）')
    .addChannelOption(opt =>
      opt
        .setName('channel')
        .setDescription('出力先チャンネル（未指定の場合は設定済みの集計チャンネルまたは現在地）')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('reset_timer')
    .setDescription('月次集計のリセット（管理者専用）')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('set_report_channel')
    .setDescription('月次集計の投稿先チャンネルを設定します（管理者専用）')
    .addChannelOption(opt =>
      opt
        .setName('channel')
        .setDescription('月次集計を投稿するチャンネル')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('log_view')
    .setDescription('職員別・期間指定で勤務ログと集計を確認します（管理者専用）')
    .addUserOption(opt =>
      opt.setName('user').setDescription('対象職員（未指定で全員）').setRequired(false)
    )
    .addStringOption(opt =>
      opt.setName('from').setDescription('開始日時（例: 2026-11-01 00:00）').setRequired(false)
    )
    .addStringOption(opt =>
      opt.setName('to').setDescription('終了日時（例: 2026-11-30 23:59）').setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('log_add')
    .setDescription('日時を指定して勤務記録を追加します（管理者専用）')
    .addUserOption(opt =>
      opt.setName('user').setDescription('対象職員').setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('start').setDescription('勤務開始日時（例: 2026-11-22 18:00）').setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('end').setDescription('勤務終了日時（例: 2026-11-22 20:30）').setRequired(true)
    )
    .addIntegerOption(opt =>
      opt.setName('cases').setDescription('対応件数').setMinValue(0).setRequired(false)
    )
    .addStringOption(opt =>
      opt.setName('notes').setDescription('備考').setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('log_edit')
    .setDescription('既存の勤務ログを修正します（管理者専用）')
    .addStringOption(opt =>
      opt.setName('log_id').setDescription('対象ログID（例: LOG-20261122-180000-123）').setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('start').setDescription('新しい開始日時（例: 2026-11-22 18:00）').setRequired(false)
    )
    .addStringOption(opt =>
      opt.setName('end').setDescription('新しい終了日時（例: 2026-11-22 20:30）').setRequired(false)
    )
    .addIntegerOption(opt =>
      opt.setName('cases').setDescription('新しい対応件数').setMinValue(0).setRequired(false)
    )
    .addStringOption(opt =>
      opt.setName('notes').setDescription('新しい備考').setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('log_delete')
    .setDescription('指定した勤務ログを削除します（管理者専用）')
    .addStringOption(opt =>
      opt.setName('log_id').setDescription('削除するログID').setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
].map(cmd => cmd.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
  console.log('✅ グローバルスラッシュコマンドを登録しました。');
}

async function buildMonthlyReportEmbed(guild) {
  const { settings } = await gas.getSettings();
  const resetAfter = settings.monthly_reset_at || null;
  const { logs } = await gas.queryLogs({ resetAfter });
  const summary = summarizeLogs(logs);

  const lines = summary.ranking.length > 0
    ? summary.ranking.map((u, idx) => {
        const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `**${idx + 1}.**`;
        return `${medal} <@${u.userId}>（${u.username}）\n└ 勤務時間: **${formatDuration(u.minutes)}** | 対応: **${u.cases}件** | 出勤: **${u.shifts}回**`;
      })
    : ['集計対象の完了済み勤務データがありません。'];

  const embed = new EmbedBuilder()
    .setColor(0x2563eb)
    .setTitle('📊 モデレーター勤怠 月次集計レポート')
    .setDescription(
      [
        guild ? `**サーバー:** ${guild.name}` : null,
        resetAfter ? `**集計開始基準:** ${formatJst(resetAfter)}` : '**集計範囲:** 全記録期間',
        '',
        `🕒 **総勤務時間:** **${formatDuration(summary.totalMinutes)}**`,
        `📁 **総対応件数:** **${summary.totalCases}件**`,
        `✅ **完了シフト数:** **${summary.shiftCount}回**`
      ]
        .filter(Boolean)
        .join('\n')
    )
    .addFields({
      name: '👤 職員別実績ランキング',
      value: lines.join('\n\n').slice(0, 1024)
    })
    .setTimestamp()
    .setFooter({ text: 'Moderator Attendance System • Monthly Report' });

  return { embed, settings };
}

client.on('interactionCreate', async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      const { commandName } = interaction;

      if (commandName === 'panel') {
        const targetLogChannel = interaction.options.getChannel('log_channel') || interaction.channel;
        if (targetLogChannel?.id) {
          await gas.setSetting(`panel_log_channel_${interaction.channelId}`, targetLogChannel.id);
        }

        const panelEmbed = new EmbedBuilder()
          .setColor(0x1d4ed8)
          .setTitle('🛡️ モデレーター勤怠管理パネル')
          .setDescription(
            [
              'Roblox RPゲームの運営モデレーター向け勤怠管理システムです。',
              '勤務を開始するときは **「勤務開始」**、終了するときは **「勤務終了」** ボタンを押してください。',
              '',
              `📌 **ログ送信先:** <#${targetLogChannel.id}>`,
              '💡 勤務終了時には入力画面（モーダル）が開き、対応件数と備考を記録できます。'
            ].join('\n')
          )
          .addFields(
            { name: '🟢 勤務開始', value: '出勤時刻を記録します', inline: true },
            { name: '🔴 勤務終了', value: '対応件数・備考を入力して退勤します', inline: true }
          )
          .setFooter({ text: 'Moderator Attendance System' })
          .setTimestamp();

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('attendance_clock_in')
            .setLabel('勤務開始')
            .setStyle(ButtonStyle.Success)
            .setEmoji('🟢'),
          new ButtonBuilder()
            .setCustomId('attendance_clock_out')
            .setLabel('勤務終了')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('🔴')
        );

        await interaction.channel.send({ embeds: [panelEmbed], components: [row] });
        await interaction.reply({
          content: `✅ <#${interaction.channelId}> に勤怠パネルを設置しました（ログ送信先: <#${targetLogChannel.id}>）。`,
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (commandName === 'status') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const [{ active }, { settings }] = await Promise.all([
          gas.getActive(interaction.user.id),
          gas.getSettings()
        ]);
        const { logs } = await gas.queryLogs({
          userId: interaction.user.id,
          resetAfter: settings?.monthly_reset_at || null
        }).catch(() => ({ logs: [] }));

        const userLogs = (logs || []).filter(l => String(l.user_id) === String(interaction.user.id));
        const summary = summarizeLogs(userLogs);

        const embed = new EmbedBuilder()
          .setColor(active ? 0x16a34a : 0x64748b)
          .setTitle('📋 あなたの現在の勤務ステータス')
          .setThumbnail(interaction.user.displayAvatarURL())
          .addFields(
            {
              name: '現在の状態',
              value: active
                ? `🟢 **勤務中**\n開始時刻: \`${formatJst(active.start_time)}\`\nログID: \`${active.log_id}\``
                : '⚪ **未出勤（待機中）**',
              inline: false
            },
            {
              name: '集計期間内の累計勤務時間',
              value: `**${formatDuration(summary.totalMinutes)}**`,
              inline: true
            },
            {
              name: '集計期間内の累計対応件数',
              value: `**${summary.totalCases}件**`,
              inline: true
            },
            {
              name: '出勤回数',
              value: `**${summary.shiftCount}回**`,
              inline: true
            }
          )
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
        return;
      }

      if (!isAdminMember(interaction)) {
        await interaction.reply({
          content: '⛔ このコマンドは管理者（サーバー管理または管理者権限）のみ実行できます。',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (commandName === 'set_report_channel') {
        const ch = interaction.options.getChannel('channel', true);
        await gas.setSetting('monthly_report_channel_id', ch.id);

        const embed = new EmbedBuilder()
          .setColor(0x0284c7)
          .setTitle('⚙️ 月次集計チャンネルを設定しました')
          .setDescription(`今後の月次集計レポートは <#${ch.id}> に送信されます。`)
          .setTimestamp();

        await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        return;
      }

      if (commandName === 'monthly_report') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const { embed, settings } = await buildMonthlyReportEmbed(interaction.guild);
        const chosenChannel =
          interaction.options.getChannel('channel') ||
          (settings.monthly_report_channel_id
            ? await interaction.guild.channels.fetch(settings.monthly_report_channel_id).catch(() => null)
            : null) ||
          interaction.channel;

        await chosenChannel.send({ embeds: [embed] });
        await interaction.editReply({
          content: `✅ 月次集計レポートを <#${chosenChannel.id}> に出力しました。`
        });
        return;
      }

      if (commandName === 'reset_timer') {
        const confirmRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('confirm_reset_timer')
            .setLabel('はい、集計基準をリセットします')
            .setStyle(ButtonStyle.Danger),
          new ButtonBuilder()
            .setCustomId('cancel_reset_timer')
            .setLabel('キャンセル')
            .setStyle(ButtonStyle.Secondary)
        );

        await interaction.reply({
          content:
            '⚠️ **月次集計のリセット確認**\n現在時刻を新しい集計開始基準として記録します（過去のログ行自体はスプレッドシートに残ります）。本当に実行しますか？',
          components: [confirmRow],
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (commandName === 'log_view') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const targetUser = interaction.options.getUser('user');
        const fromRaw = interaction.options.getString('from');
        const toRaw = interaction.options.getString('to');

        const fromIso = fromRaw ? parseJstDateInput(fromRaw) : null;
        const toIso = toRaw ? parseJstDateInput(toRaw) : null;

        if (fromRaw && !fromIso) {
          await interaction.editReply('❌ `from` の日時形式が正しくありません（例: `2026-11-01 00:00`）。');
          return;
        }
        if (toRaw && !toIso) {
          await interaction.editReply('❌ `to` の日時形式が正しくありません（例: `2026-11-30 23:59`）。');
          return;
        }

        const { logs } = await gas.queryLogs({
          userId: targetUser ? targetUser.id : null,
          fromDate: fromIso,
          toDate: toIso
        });

        const summary = summarizeLogs(logs);
        const recent = [...logs].slice(-10).reverse();

        const logLines = recent.length > 0
          ? recent.map(r => {
              const durText = r.status === 'ACTIVE'
                ? '🟢 勤務中'
                : `${formatDuration(r.duration_minutes)}（対応: ${r.cases_count || 0}件）`;
              return `\`${r.log_id}\` | **${r.username}**\n└ ${formatJst(r.start_time)} 〜 ${r.end_time ? formatJst(r.end_time) : '未退勤'} | ${durText}${r.notes ? `\n└ 備考: ${r.notes}` : ''}`;
            })
          : ['該当する勤務ログはありません。'];

        const embed = new EmbedBuilder()
          .setColor(0x0f766e)
          .setTitle('📑 勤務ログ照会・集計結果')
          .setDescription(
            [
              `**対象職員:** ${targetUser ? `<@${targetUser.id}>` : '全員'}`,
              `**期間:** ${fromIso ? formatJst(fromIso) : '指定なし'} 〜 ${toIso ? formatJst(toIso) : '指定なし'}`,
              `**合計勤務時間:** **${formatDuration(summary.totalMinutes)}** | **合計対応件数:** **${summary.totalCases}件** | **完了シフト:** **${summary.shiftCount}回**`
            ].join('\n')
          )
          .addFields({
            name: `直近ログ（最大10件 / 全${logs.length}件ヒット）`,
            value: logLines.join('\n\n').slice(0, 1024)
          })
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
        return;
      }

      if (commandName === 'log_add') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const targetUser = interaction.options.getUser('user', true);
        const startIso = parseJstDateInput(interaction.options.getString('start', true));
        const endIso = parseJstDateInput(interaction.options.getString('end', true));
        const casesCount = interaction.options.getInteger('cases') ?? 0;
        const notes = interaction.options.getString('notes') ?? '';

        if (!startIso || !endIso) {
          await interaction.editReply('❌ 日時形式が正しくありません（例: `2026-11-22 18:00`）。');
          return;
        }
        if (new Date(endIso).getTime() < new Date(startIso).getTime()) {
          await interaction.editReply('❌ 終了日時は開始日時より後に設定してください。');
          return;
        }

        const created = await gas.manualAdd({
          userId: targetUser.id,
          username: targetUser.globalName || targetUser.username,
          startTime: startIso,
          endTime: endIso,
          casesCount,
          notes,
          adminName: interaction.user.globalName || interaction.user.username
        });

        const embed = new EmbedBuilder()
          .setColor(0x16a34a)
          .setTitle('➕ 勤務記録を追加しました')
          .addFields(
            { name: 'ログID', value: `\`${created.log_id}\``, inline: true },
            { name: '対象職員', value: `<@${targetUser.id}>`, inline: true },
            { name: '勤務時間', value: `**${formatDuration(created.duration_minutes)}**`, inline: true },
            { name: '開始 〜 終了', value: `${formatJst(created.start_time)} 〜 ${formatJst(created.end_time)}`, inline: false },
            { name: '対応件数 / 備考', value: `${created.cases_count}件 / ${created.notes || 'なし'}`, inline: false }
          )
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
        return;
      }

      if (commandName === 'log_edit') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const logId = interaction.options.getString('log_id', true).trim();
        const startRaw = interaction.options.getString('start');
        const endRaw = interaction.options.getString('end');
        const casesCount = interaction.options.getInteger('cases');
        const notes = interaction.options.getString('notes');

        const startIso = startRaw ? parseJstDateInput(startRaw) : undefined;
        const endIso = endRaw ? parseJstDateInput(endRaw) : undefined;

        if (startRaw && !startIso) {
          await interaction.editReply('❌ `start` の日時形式が正しくありません（例: `2026-11-22 18:00`）。');
          return;
        }
        if (endRaw && !endIso) {
          await interaction.editReply('❌ `end` の日時形式が正しくありません（例: `2026-11-22 20:30`）。');
          return;
        }

        const updated = await gas.editLog({
          logId,
          startTime: startIso,
          endTime: endIso,
          casesCount: casesCount !== null ? casesCount : undefined,
          notes: notes !== null ? notes : undefined,
          adminName: interaction.user.globalName || interaction.user.username
        });

        const embed = new EmbedBuilder()
          .setColor(0xd97706)
          .setTitle('✏️ 勤務ログを修正しました')
          .addFields(
            { name: 'ログID', value: `\`${updated.log_id}\``, inline: true },
            { name: '職員', value: `${updated.username} (<@${updated.user_id}>)`, inline: true },
            { name: '再計算後の勤務時間', value: `**${formatDuration(updated.duration_minutes)}**`, inline: true },
            { name: '開始 〜 終了', value: `${formatJst(updated.start_time)} 〜 ${updated.end_time ? formatJst(updated.end_time) : '未退勤'}`, inline: false },
            { name: '対応件数 / 備考', value: `${updated.cases_count}件 / ${updated.notes || 'なし'}`, inline: false }
          )
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
        return;
      }

      if (commandName === 'log_delete') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const logId = interaction.options.getString('log_id', true).trim();
        await gas.deleteLog(logId);
        await interaction.editReply(`🗑️ ログ \`${logId}\` を削除しました。`);
        return;
      }
    }

    if (interaction.isButton()) {
      if (interaction.customId === 'attendance_clock_in') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const displayName = interaction.member?.displayName || interaction.user.globalName || interaction.user.username;
        const res = await gas.clockIn(interaction.user.id, displayName);

        if (res.alreadyActive) {
          await interaction.editReply({
            content: `⚠️ すでに勤務中です（開始時刻: \`${formatJst(res.log.start_time)}\` / ログID: \`${res.log.log_id}\`）。`
          });
          return;
        }

        const embed = new EmbedBuilder()
          .setColor(0x16a34a)
          .setTitle('🟢 勤務開始を記録しました')
          .addFields(
            { name: 'ユーザー', value: `<@${interaction.user.id}> (${displayName})`, inline: true },
            { name: '開始時刻', value: `\`${formatJst(res.log.start_time)}\``, inline: true },
            { name: 'ログID', value: `\`${res.log.log_id}\``, inline: false }
          )
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
        return;
      }

      if (interaction.customId === 'attendance_clock_out') {
        const { active } = await gas.getActive(interaction.user.id);
        if (!active) {
          await interaction.reply({
            content: '⚠️ 現在「勤務中」の記録が見つかりません。先に **勤務開始** を押してください。',
            flags: MessageFlags.Ephemeral
          });
          return;
        }

        const displayName = interaction.member?.displayName || interaction.user.globalName || interaction.user.username;

        const modal = new ModalBuilder()
          .setCustomId('attendance_clock_out_modal')
          .setTitle('勤務終了・実績入力');

        const usernameInput = new TextInputBuilder()
          .setCustomId('confirm_username')
          .setLabel('ユーザーネーム確認')
          .setStyle(TextInputStyle.Short)
          .setValue(String(displayName).slice(0, 100))
          .setRequired(true);

        const startTimeInput = new TextInputBuilder()
          .setCustomId('confirm_start_time')
          .setLabel('勤務開始時刻確認（JST）')
          .setStyle(TextInputStyle.Short)
          .setValue(formatJst(active.start_time).slice(0, 100))
          .setRequired(true);

        const casesInput = new TextInputBuilder()
          .setCustomId('cases_count')
          .setLabel('対応件数（半角数字）')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('例: 5')
          .setRequired(true);

        const notesInput = new TextInputBuilder()
          .setCustomId('notes')
          .setLabel('備考欄（任意）')
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder('対応内容の補足や引き継ぎ事項があれば入力してください')
          .setRequired(false);

        modal.addComponents(
          new ActionRowBuilder().addComponents(usernameInput),
          new ActionRowBuilder().addComponents(startTimeInput),
          new ActionRowBuilder().addComponents(casesInput),
          new ActionRowBuilder().addComponents(notesInput)
        );

        await interaction.showModal(modal);
        return;
      }

      if (interaction.customId === 'confirm_reset_timer') {
        if (!isAdminMember(interaction)) {
          await interaction.reply({ content: '⛔ 管理者権限が必要です。', flags: MessageFlags.Ephemeral });
          return;
        }
        const nowIso = new Date().toISOString();
        await gas.setSetting('monthly_reset_at', nowIso);
        await interaction.update({
          content: `✅ 月次集計の基準日時を \`${formatJst(nowIso)}\` にリセットしました。`,
          components: []
        });
        return;
      }

      if (interaction.customId === 'cancel_reset_timer') {
        await interaction.update({
          content: 'キャンセルしました。月次集計の基準は変更されていません。',
          components: []
        });
        return;
      }
    }

    if (interaction.isModalSubmit() && interaction.customId === 'attendance_clock_out_modal') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const confirmedUser = interaction.fields.getTextInputValue('confirm_username').trim();
      const casesRaw = interaction.fields.getTextInputValue('cases_count').trim();
      const notes = interaction.fields.getTextInputValue('notes').trim();

      const casesCount = parseInt(casesRaw, 10);
      if (isNaN(casesCount) || casesCount < 0) {
        await interaction.editReply('❌ 対応件数は 0 以上の半角数字で入力してください（例: `0`, `3`, `12`）。');
        return;
      }

      const completed = await gas.clockOut(
        interaction.user.id,
        confirmedUser || interaction.user.username,
        casesCount,
        notes
      );

      const logEmbed = new EmbedBuilder()
        .setColor(0x2563eb)
        .setTitle('📝 勤務終了レポート')
        .setAuthor({
          name: `${confirmedUser} (${interaction.user.tag})`,
          iconURL: interaction.user.displayAvatarURL()
        })
        .addFields(
          { name: '👤 担当モデレーター', value: `<@${interaction.user.id}>`, inline: true },
          { name: '⏱️ 勤務時間', value: `**${formatDuration(completed.duration_minutes)}**`, inline: true },
          { name: '📁 対応件数', value: `**${completed.cases_count}件**`, inline: true },
          { name: '🟢 勤務開始', value: `\`${formatJst(completed.start_time)}\``, inline: true },
          { name: '🔴 勤務終了', value: `\`${formatJst(completed.end_time)}\``, inline: true },
          { name: '🆔 ログID', value: `\`${completed.log_id}\``, inline: true },
          { name: '🗒️ 備考', value: completed.notes ? completed.notes : 'なし', inline: false }
        )
        .setTimestamp();

      const { settings } = await gas.getSettings();
      const panelChannelKey = `panel_log_channel_${interaction.channelId}`;
      const targetChannelId = settings[panelChannelKey] || interaction.channelId;
      const targetChannel = await interaction.guild.channels.fetch(targetChannelId).catch(() => interaction.channel);

      await targetChannel.send({ embeds: [logEmbed] });

      await interaction.editReply({
        content: `✅ 勤務終了データを保存し、<#${targetChannel.id}> にログを送信しました（勤務時間: **${formatDuration(completed.duration_minutes)}**）。`
      });
    }
  } catch (err) {
    console.error('Interaction Error:', err);
    const errorMessage = `❌ エラーが発生しました: ${err.message}`;
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: errorMessage }).catch(() => {});
    } else {
      await interaction.reply({ content: errorMessage, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
});

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({
    ok: true,
    bot: client.user ? client.user.tag : 'starting',
    uptimeSeconds: Math.floor(process.uptime())
  }));
});

server.listen(PORT, () => {
  console.log(`🌐 HTTPヘルスチェックサーバーがポート ${PORT} で待機中です。`);
});

console.log('🔄 Discordへログインを開始します...');

client.once('clientReady', async () => {
  console.log(`🤖 ログイン完了: ${client.user.tag}`);
  await registerCommands();
});

client.on('error', err => {
  console.error('❌ Discordクライアントエラー:', err);
});

const cleanToken = String(TOKEN || '').trim();
console.log(
  `🔍 トークン確認: length=${cleanToken.length}, hasWhitespace=${/\s/.test(cleanToken)}, startsWithBot=${cleanToken.startsWith('Bot ')}`
);
console.log('🔄 Discordへログインを開始します...');

client.on('debug', msg => {
  console.log('🪲 [debug]:', msg);
});

client.once('clientReady', async () => {
  console.log(`🤖 ログイン完了: ${client.user.tag}`);
  await registerCommands();
});

client.on('error', err => {
  console.error('❌ Discordクライアントエラー:', err);
});

const loginTimer = setTimeout(() => {
  console.warn(
    '⚠️ ログイン開始から10秒経過しましたが完了していません（Gateway接続待ち、または環境変数・ネットワーク側のブロックの可能性があります）。'
  );
}, 10000);

import dns from 'node:dns';

// IPv6解決待ちによる接続詰まりを防ぐテスト
if (typeof dns.setDefaultResultOrder === 'function') {
  dns.setDefaultResultOrder('ipv4first');
}

const cleanToken = String(TOKEN || '').trim();
console.log(
  `🔍 トークン確認: length=${cleanToken.length}, hasWhitespace=${/\s/.test(cleanToken)}, startsWithBot=${cleanToken.startsWith('Bot ')}`
);

// Discord Gatewayエンドポイントへの疎通テスト
(async () => {
  try {
    console.log('🌐 /api/v10/gateway へ疎通確認中...');
    const res = await fetch('https://discord.com/api/v10/gateway', {
      headers: { Authorization: `Bot ${cleanToken}` },
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json();
    console.log('📡 Gateway API レスポンス:', res.status, data);
  } catch (err) {
    console.error('❌ Gateway API 疎通エラー:', err);
  }
})();

console.log('🔄 Discordへログインを開始します...');

client.on('debug', msg => {
  console.log('🪲 [debug]:', msg);
});

client.once('clientReady', async () => {
  console.log(`🤖 ログイン完了: ${client.user.tag}`);
  await registerCommands();
});

client.on('error', err => {
  console.error('❌ Discordクライアントエラー:', err);
});

client.login(cleanToken).catch(err => {
  console.error('❌ Discordログイン失敗:', err);
});
