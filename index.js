import 'dotenv/config';
import http from 'node:http';
import dns from 'node:dns';
import { createRequire } from 'node:module';
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  PermissionFlagsBits,
  MessageFlags,
} from 'discord.js';

const require = createRequire(import.meta.url);
const GasClient = require('./gasClient.js');

if (typeof dns.setDefaultResultOrder === 'function') {
  dns.setDefaultResultOrder('ipv4first');
}

const DEFAULT_LOG_CHANNEL_ID = '1469729912809062491';

const TOKEN = String(process.env.DISCORD_TOKEN || '').trim();
const CLIENT_ID = String(process.env.CLIENT_ID || '').trim();
const GAS_WEB_APP_URL = String(process.env.GAS_WEB_APP_URL || '').trim();
const LOG_CHANNEL_ID = String(process.env.LOG_CHANNEL_ID || DEFAULT_LOG_CHANNEL_ID).trim();
const PORT = Number(process.env.PORT || 10000);

// 管理者コマンドを許可するロールID（カンマ区切りで複数指定可能）
// 例: ADMIN_ROLE_IDS=1563444247863230485
const ADMIN_ROLE_IDS = String(process.env.ADMIN_ROLE_IDS || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

// ロール制限をかける管理者コマンド一覧
const ADMIN_ONLY_COMMANDS = new Set([
  'panel',
  'manual-add',
  'edit-log',
  'delete-log',
  'logs',
  'settings',
]);

const COLORS = {
  neutral: 0x1e293b,
  active: 0x0f766e,
  closed: 0x991b1b,
  accent: 0x1d4ed8,
};

if (!TOKEN || !CLIENT_ID || !GAS_WEB_APP_URL) {
  console.error('必須環境変数（DISCORD_TOKEN, CLIENT_ID, GAS_WEB_APP_URL）を確認してください。');
}

const gasClient = new GasClient(GAS_WEB_APP_URL);
const busyUsers = new Set();

const healthServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('OK');
});

healthServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Health server listening on port ${PORT}`);
});

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

// 指定された管理者ロールを持っているか判定（ADMIN_ROLE_IDS 未設定時は管理者権限のみ許可）
function hasAdminRole(interaction) {
  if (ADMIN_ROLE_IDS.length === 0) {
    return Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.Administrator));
  }

  const memberRoles = interaction.member?.roles;
  if (!memberRoles) return false;

  if (typeof memberRoles.cache?.has === 'function') {
    return ADMIN_ROLE_IDS.some((roleId) => memberRoles.cache.has(roleId));
  }
  if (Array.isArray(memberRoles)) {
    return ADMIN_ROLE_IDS.some((roleId) => memberRoles.includes(roleId));
  }
  return false;
}

const commands = [
  new SlashCommandBuilder()
    .setName('panel')
    .setDescription('勤怠管理パネルを設置します')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('status')
    .setDescription('現在の勤務状況を確認します'),

  new SlashCommandBuilder()
    .setName('logs')
    .setDescription('直近の勤怠履歴を確認します')
    .addUserOption((opt) =>
      opt.setName('target').setDescription('対象ユーザー（省略時は全体）').setRequired(false)
    )
    .addIntegerOption((opt) =>
      opt
        .setName('limit')
        .setDescription('取得件数（1〜20 / 既定: 5）')
        .setMinValue(1)
        .setMaxValue(20)
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('manual-add')
    .setDescription('勤怠ログを手動追加します')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addUserOption((opt) =>
      opt.setName('user').setDescription('対象ユーザー').setRequired(true)
    )
    .addStringOption((opt) =>
      opt.setName('start_time').setDescription('開始日時（例: 2026-11-22 21:00）').setRequired(true)
    )
    .addStringOption((opt) =>
      opt.setName('end_time').setDescription('終了日時（例: 2026-11-22 22:30）').setRequired(false)
    )
    .addIntegerOption((opt) =>
      opt.setName('cases').setDescription('対応件数（既定: 0）').setMinValue(0).setRequired(false)
    )
    .addStringOption((opt) =>
      opt.setName('notes').setDescription('対応内容・備考').setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('edit-log')
    .setDescription('既存の勤怠ログを編集します')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((opt) =>
      opt.setName('log_id').setDescription('対象ログID').setRequired(true)
    )
    .addIntegerOption((opt) =>
      opt.setName('cases').setDescription('対応件数').setMinValue(0).setRequired(false)
    )
    .addStringOption((opt) =>
      opt.setName('notes').setDescription('対応内容・備考').setRequired(false)
    )
    .addStringOption((opt) =>
      opt.setName('start_time').setDescription('開始日時').setRequired(false)
    )
    .addStringOption((opt) =>
      opt.setName('end_time').setDescription('終了日時').setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('delete-log')
    .setDescription('既存の勤怠ログを削除します')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((opt) =>
      opt.setName('log_id').setDescription('削除するログID').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('settings')
    .setDescription('システム設定の確認・更新')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((opt) =>
      opt.setName('key').setDescription('設定キー（省略時は一覧）').setRequired(false)
    )
    .addStringOption((opt) =>
      opt.setName('value').setDescription('設定値').setRequired(false)
    ),
].map((cmd) => cmd.toJSON());

async function registerCommands() {
  if (!TOKEN || !CLIENT_ID) return;
  try {
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('Slash commands registered.');
  } catch (err) {
    console.error('Command registration error:', err);
  }
}

function formatDuration(startRaw) {
  if (!startRaw) return null;
  const startMs = Date.parse(startRaw);
  if (Number.isNaN(startMs)) return null;
  const diffMin = Math.max(0, Math.floor((Date.now() - startMs) / 60000));
  const hours = Math.floor(diffMin / 60);
  const mins = diffMin % 60;
  return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
}

function formatCodeBlock(value, maxLen = 1000) {
  const str = String(value ?? '').trim();
  if (!str) return '—';
  return `\`\`\`\n${str.slice(0, maxLen)}\n\`\`\``;
}

function buildPanelEmbed() {
  return new EmbedBuilder()
    .setTitle('ATTENDANCE // DUTY CONTROL')
    .setColor(COLORS.neutral)
    .setDescription(
      [
        '勤務セッションの開始・終了および稼働状況の確認を行います。',
        '',
        '`勤務開始` セッションを開始',
        '`勤務終了` 対応件数と報告を提出して終了',
        '`稼働状況` 現在のセッションを確認',
      ].join('\n')
    )
    .setFooter({ text: 'Moderator Duty System' })
    .setTimestamp();
}

function buildStatusEmbed(user, data) {
  const embed = new EmbedBuilder().setTimestamp();

  if (!data || (!data.active && !data.log && !data.startTime)) {
    return embed
      .setTitle('DUTY STATUS // OFF DUTY')
      .setColor(COLORS.neutral)
      .setDescription(`${user} は現在 **待機中（未出勤）** です。`);
  }

  const record = data.log || data;
  const startTime = String(record.startTime || record.startedAt || '—');
  const duration = formatDuration(record.startTime || record.startedAt) || '—';
  const cases = record.casesCount ?? record.cases ?? 0;

  embed
    .setTitle('DUTY STATUS // ON DUTY')
    .setColor(COLORS.active)
    .setDescription(`${user} は現在 **勤務中** です。`)
    .addFields(
      { name: '開始時刻', value: `\`${startTime}\``, inline: true },
      { name: '経過時間', value: `\`${duration}\``, inline: true },
      { name: '対応件数', value: `\`${cases} 件\``, inline: true }
    );

  if (record.notes) {
    embed.addFields({ name: '備考', value: formatCodeBlock(record.notes), inline: false });
  }
  return embed;
}

function buildClockInEmbed(user, displayName, data) {
  const startTime =
    data?.startTime ||
    data?.startedAt ||
    new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });

  const embed = new EmbedBuilder()
    .setTitle('SHIFT START')
    .setColor(COLORS.active)
    .addFields(
      { name: '担当者', value: `${displayName}\n${user}`, inline: true },
      { name: '開始時刻', value: `\`${startTime}\``, inline: true }
    )
    .setTimestamp();

  const logId = data?.logId || data?.id;
  if (logId) {
    embed.setFooter({ text: `ID: ${logId}` });
  }
  return embed;
}

function buildClockOutEmbed(user, displayName, casesCount, notes, data) {
  const endTime =
    data?.endTime ||
    data?.endedAt ||
    new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  const duration =
    data?.duration || formatDuration(data?.startTime || data?.startedAt) || '—';

  const embed = new EmbedBuilder()
    .setTitle('SHIFT REPORT // COMPLETED')
    .setColor(COLORS.closed)
    .addFields(
      { name: '担当者', value: `${displayName}\n${user}`, inline: true },
      { name: '対応件数', value: `\`${casesCount} 件\``, inline: true },
      { name: '稼働時間', value: `\`${duration}\``, inline: true },
      { name: '終了時刻', value: `\`${endTime}\``, inline: false },
      { name: '対応内容・引き継ぎ', value: formatCodeBlock(notes), inline: false }
    )
    .setTimestamp();

  const logId = data?.logId || data?.id;
  if (logId) {
    embed.setFooter({ text: `ID: ${logId}` });
  }
  return embed;
}

async function sendShiftReportChannel(clientInstance, embed) {
  if (!LOG_CHANNEL_ID) return;
  try {
    const channel = await clientInstance.channels.fetch(LOG_CHANNEL_ID);
    if (channel && channel.isTextBased()) {
      await channel.send({ embeds: [embed] });
    } else {
      console.warn(`Log channel ${LOG_CHANNEL_ID} is not a text channel.`);
    }
  } catch (err) {
    console.error(`Failed to send log to ${LOG_CHANNEL_ID}:`, err?.message || err);
  }
}

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await registerCommands();
});

client.on('error', (err) => {
  console.error('Discord client error:', err);
});

client.on('interactionCreate', async (interaction) => {
  const userId = interaction.user.id;
  const displayName = interaction.member?.displayName || interaction.user.username;

  try {
    if (interaction.isChatInputCommand()) {
      // 管理者限定コマンドのロールチェック
      if (ADMIN_ONLY_COMMANDS.has(interaction.commandName) && !hasAdminRole(interaction)) {
        await interaction.reply({
          content: 'この管理者コマンドを実行する権限がありません。',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      switch (interaction.commandName) {
        case 'panel': {
          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId('shift_start')
              .setLabel('勤務開始')
              .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
              .setCustomId('shift_end')
              .setLabel('勤務終了')
              .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
              .setCustomId('shift_status_btn')
              .setLabel('稼働状況')
              .setStyle(ButtonStyle.Secondary)
          );

          await interaction.reply({ embeds: [buildPanelEmbed()], components: [row] });
          break;
        }

        case 'status': {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          const data = await gasClient.getActive(userId);
          await interaction.editReply({ embeds: [buildStatusEmbed(interaction.user, data)] });
          break;
        }

        case 'logs': {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          const targetUser = interaction.options.getUser('target');
          const limit = interaction.options.getInteger('limit') || 5;
          const filters = { limit };
          if (targetUser) filters.userId = targetUser.id;

          const data = await gasClient.queryLogs(filters);
          const logsList = Array.isArray(data) ? data : data?.logs || data?.items || [];

          if (!logsList.length) {
            await interaction.editReply({ content: '該当する勤怠ログはありません。' });
            return;
          }

          const lines = logsList.slice(0, limit).map((item, idx) => {
            const id = item.logId || item.id || `#${idx + 1}`;
            const who = item.username || item.userId || '不明';
            const cases = item.casesCount ?? item.cases ?? 0;
            const start = item.startTime || item.startedAt || '—';
            const end = item.endTime || item.endedAt || '勤務中';
            const note = item.notes ? ` | ${String(item.notes).replace(/\s+/g, ' ').slice(0, 36)}` : '';
            return `\`${id}\` **${who}** — ${start} → ${end} (\`${cases}件\`)${note}`;
          });

          const embed = new EmbedBuilder()
            .setTitle('DUTY LOGS')
            .setColor(COLORS.accent)
            .setDescription(lines.join('\n').slice(0, 4000))
            .setTimestamp();

          await interaction.editReply({ embeds: [embed] });
          break;
        }

        case 'manual-add': {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          const targetUser = interaction.options.getUser('user', true);
          const startTime = interaction.options.getString('start_time', true);
          const endTime = interaction.options.getString('end_time') || null;
          const casesCount = interaction.options.getInteger('cases') ?? 0;
          const notes = interaction.options.getString('notes') || `手動追加（${displayName}）`;

          const data = await gasClient.manualAdd({
            userId: targetUser.id,
            username: targetUser.globalName || targetUser.username,
            startTime,
            endTime,
            casesCount,
            notes,
            addedBy: userId,
          });

          const embed = new EmbedBuilder()
            .setTitle('MANUAL LOG // ADDED')
            .setColor(COLORS.accent)
            .addFields(
              { name: '対象', value: `${targetUser}`, inline: true },
              { name: '対応件数', value: `\`${casesCount} 件\``, inline: true },
              { name: '期間', value: `\`${startTime} 〜 ${endTime || '—'}\``, inline: false },
              { name: '備考', value: formatCodeBlock(notes), inline: false }
            )
            .setTimestamp();

          const logId = data?.logId || data?.id;
          if (logId) embed.setFooter({ text: `ID: ${logId}` });

          await interaction.editReply({ embeds: [embed] });
          break;
        }

        case 'edit-log': {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          const logId = interaction.options.getString('log_id', true);
          const params = { logId, editedBy: userId };

          const cases = interaction.options.getInteger('cases');
          const notes = interaction.options.getString('notes');
          const startTime = interaction.options.getString('start_time');
          const endTime = interaction.options.getString('end_time');

          if (cases !== null && cases !== undefined) params.casesCount = cases;
          if (notes !== null && notes !== undefined) params.notes = notes;
          if (startTime !== null && startTime !== undefined) params.startTime = startTime;
          if (endTime !== null && endTime !== undefined) params.endTime = endTime;

          await gasClient.editLog(params);
          await interaction.editReply({ content: `ログ \`${logId}\` を更新しました。` });
          break;
        }

        case 'delete-log': {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          const logId = interaction.options.getString('log_id', true);
          await gasClient.deleteLog(logId);
          await interaction.editReply({ content: `ログ \`${logId}\` を削除しました。` });
          break;
        }

        case 'settings': {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          const key = interaction.options.getString('key');
          const value = interaction.options.getString('value');

          if (key && value !== null && value !== undefined) {
            await gasClient.setSetting(key, value);
            await interaction.editReply({ content: `設定を更新しました: \`${key}\` = \`${value}\`` });
          } else {
            const settings = await gasClient.getSettings();
            await interaction.editReply({
              content: `**SYSTEM SETTINGS**\n${formatCodeBlock(JSON.stringify(settings ?? {}, null, 2), 1800)}`,
            });
          }
          break;
        }
      }
    } else if (interaction.isButton()) {
      if (interaction.customId === 'shift_start') {
        if (busyUsers.has(userId)) {
          await interaction.reply({ content: '処理中です。しばらくお待ちください。', flags: MessageFlags.Ephemeral });
          return;
        }
        busyUsers.add(userId);
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
          const data = await gasClient.clockIn(userId, displayName);
          await interaction.editReply({ embeds: [buildClockInEmbed(interaction.user, displayName, data)] });
        } finally {
          busyUsers.delete(userId);
        }
      } else if (interaction.customId === 'shift_status_btn') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const data = await gasClient.getActive(userId);
        await interaction.editReply({ embeds: [buildStatusEmbed(interaction.user, data)] });
      } else if (interaction.customId === 'shift_end') {
        const modal = new ModalBuilder()
          .setCustomId('shift_end_modal')
          .setTitle('勤務終了報告');

        const casesInput = new TextInputBuilder()
          .setCustomId('cases_count')
          .setLabel('対応件数（数字 / 未入力は0）')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setPlaceholder('0');

        const noteInput = new TextInputBuilder()
          .setCustomId('shift_note')
          .setLabel('対応内容・引き継ぎ事項（任意）')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setPlaceholder('巡回・対応内容・引き継ぎ事項など');

        modal.addComponents(
          new ActionRowBuilder().addComponents(casesInput),
          new ActionRowBuilder().addComponents(noteInput)
        );
        await interaction.showModal(modal);
      }
    } else if (interaction.isModalSubmit()) {
      if (interaction.customId === 'shift_end_modal') {
        if (busyUsers.has(userId)) {
          await interaction.reply({ content: '処理中です。しばらくお待ちください。', flags: MessageFlags.Ephemeral });
          return;
        }
        busyUsers.add(userId);
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
          const rawCases = interaction.fields.getTextInputValue('cases_count')?.trim();
          const casesCount =
            rawCases && !Number.isNaN(Number(rawCases))
              ? Math.max(0, Math.floor(Number(rawCases)))
              : 0;
          const notes = interaction.fields.getTextInputValue('shift_note')?.trim() || '';

          const data = await gasClient.clockOut(userId, displayName, casesCount, notes);
          const embed = buildClockOutEmbed(interaction.user, displayName, casesCount, notes, data);

          await interaction.editReply({ embeds: [embed] });
          await sendShiftReportChannel(client, embed);
        } finally {
          busyUsers.delete(userId);
        }
      }
    }
  } catch (err) {
    console.error('Interaction error:', err);
    const msg = `エラーが発生しました: \`${err?.message || err}\``.slice(0, 1900);
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: msg, flags: MessageFlags.Ephemeral }).catch(() => {});
    } else {
      await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

client.login(TOKEN).catch((err) => {
  console.error('Discord login failed:', err);
});
