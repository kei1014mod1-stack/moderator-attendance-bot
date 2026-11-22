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

const TOKEN = String(process.env.DISCORD_TOKEN || '').trim();
const CLIENT_ID = String(process.env.CLIENT_ID || '').trim();
const GAS_WEB_APP_URL = String(process.env.GAS_WEB_APP_URL || '').trim();
const LOG_CHANNEL_ID = String(process.env.LOG_CHANNEL_ID || '').trim();
const PORT = Number(process.env.PORT || 10000);

if (!TOKEN || !CLIENT_ID || !GAS_WEB_APP_URL) {
  console.error('❌ 必須環境変数（DISCORD_TOKEN, CLIENT_ID, GAS_WEB_APP_URL）を確認してください。');
}

const gasClient = new GasClient(GAS_WEB_APP_URL);
const busyUsers = new Set();

// Render Web Service 用ヘルスチェックサーバー
const healthServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('OK');
});

healthServer.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 ヘルスチェックサーバー起動 (port: ${PORT})`);
});

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const commands = [
  new SlashCommandBuilder()
    .setName('panel')
    .setDescription('モデレーター勤怠管理パネルを設置します')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName('status')
    .setDescription('現在の勤務状況を確認します'),

  new SlashCommandBuilder()
    .setName('logs')
    .setDescription('直近の勤怠履歴を確認します')
    .addUserOption((opt) =>
      opt.setName('target').setDescription('絞り込むユーザー（省略時は全員）').setRequired(false)
    )
    .addIntegerOption((opt) =>
      opt
        .setName('limit')
        .setDescription('表示件数（1〜20、デフォルト5）')
        .setMinValue(1)
        .setMaxValue(20)
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('manual-add')
    .setDescription('勤怠ログを手動で追加します（管理者向け）')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addUserOption((opt) =>
      opt.setName('user').setDescription('対象ユーザー').setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName('start_time')
        .setDescription('開始日時（例: 2026-11-22 21:00）')
        .setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName('end_time')
        .setDescription('終了日時（例: 2026-11-22 22:30 / 未入力可）')
        .setRequired(false)
    )
    .addIntegerOption((opt) =>
      opt.setName('cases').setDescription('対応件数（デフォルト0）').setMinValue(0).setRequired(false)
    )
    .addStringOption((opt) =>
      opt.setName('notes').setDescription('対応内容・メモ').setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('edit-log')
    .setDescription('既存の勤怠ログを編集します（管理者向け）')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((opt) =>
      opt.setName('log_id').setDescription('対象ログID').setRequired(true)
    )
    .addIntegerOption((opt) =>
      opt.setName('cases').setDescription('新しい対応件数').setMinValue(0).setRequired(false)
    )
    .addStringOption((opt) =>
      opt.setName('notes').setDescription('新しい対応内容・メモ').setRequired(false)
    )
    .addStringOption((opt) =>
      opt.setName('start_time').setDescription('新しい開始日時').setRequired(false)
    )
    .addStringOption((opt) =>
      opt.setName('end_time').setDescription('新しい終了日時').setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('delete-log')
    .setDescription('既存の勤怠ログを削除します（管理者向け）')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((opt) =>
      opt.setName('log_id').setDescription('削除するログID').setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('settings')
    .setDescription('勤怠システム設定の確認・変更（管理者向け）')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((opt) =>
      opt.setName('key').setDescription('変更する設定キー（省略時は一覧表示）').setRequired(false)
    )
    .addStringOption((opt) =>
      opt.setName('value').setDescription('設定する値').setRequired(false)
    ),
].map((cmd) => cmd.toJSON());

async function registerCommands() {
  if (!TOKEN || !CLIENT_ID) return;
  try {
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('✅ グローバルスラッシュコマンドを同期しました。');
  } catch (err) {
    console.error('❌ コマンド登録エラー:', err);
  }
}

function formatDuration(startRaw) {
  if (!startRaw) return null;
  const startMs = Date.parse(startRaw);
  if (Number.isNaN(startMs)) return null;
  const diffMin = Math.max(0, Math.floor((Date.now() - startMs) / 60000));
  const hours = Math.floor(diffMin / 60);
  const mins = diffMin % 60;
  return hours > 0 ? `${hours}時間${mins}分` : `${mins}分`;
}

function buildStatusEmbed(user, data) {
  const embed = new EmbedBuilder().setTimestamp();

  if (!data || (!data.active && !data.log && !data.startTime)) {
    return embed
      .setTitle('📋 現在の勤務状況')
      .setColor(0x64748b)
      .setDescription(`${user} さんは現在**勤務中ではありません**。`);
  }

  const record = data.log || data;
  const duration = formatDuration(record.startTime || record.startedAt);

  embed
    .setTitle('🟢 現在勤務中')
    .setColor(0x16a34a)
    .setDescription(`${user} さんの現在のセッション情報です。`)
    .addFields(
      { name: '開始時刻', value: String(record.startTime || record.startedAt || '記録なし'), inline: true },
      { name: '経過時間', value: duration || '計測中', inline: true },
      { name: '現在の対応件数', value: `${record.casesCount ?? record.cases ?? 0} 件`, inline: true }
    );

  if (record.notes) {
    embed.addFields({ name: 'メモ', value: String(record.notes).slice(0, 1024), inline: false });
  }
  return embed;
}

function buildClockInEmbed(user, displayName, data) {
  const startTime = data?.startTime || data?.startedAt || new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  const embed = new EmbedBuilder()
    .setTitle('✅ 勤務開始を記録しました')
    .setColor(0x16a34a)
    .addFields(
      { name: '担当', value: `${displayName} (${user})`, inline: true },
      { name: '開始時刻', value: String(startTime), inline: true }
    )
    .setTimestamp();

  if (data?.logId || data?.id) {
    embed.setFooter({ text: `Log ID: ${data.logId || data.id}` });
  }
  return embed;
}

function buildClockOutEmbed(user, displayName, casesCount, notes, data) {
  const endTime = data?.endTime || data?.endedAt || new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  const durationText = data?.duration || formatDuration(data?.startTime || data?.startedAt) || '算出済';

  const embed = new EmbedBuilder()
    .setTitle('🛑 勤務終了を記録しました')
    .setColor(0xdc2626)
    .addFields(
      { name: '担当', value: `${displayName} (${user})`, inline: true },
      { name: '対応件数', value: `${casesCount} 件`, inline: true },
      { name: '勤務時間', value: String(durationText), inline: true },
      { name: '終了時刻', value: String(endTime), inline: false },
      { name: '対応内容・引き継ぎ事項', value: notes ? notes.slice(0, 1024) : 'なし', inline: false }
    )
    .setTimestamp();

  if (data?.logId || data?.id) {
    embed.setFooter({ text: `Log ID: ${data.logId || data.id}` });
  }
  return embed;
}

async function sendShiftReportChannel(clientInstance, embed) {
  if (!LOG_CHANNEL_ID) return;
  try {
    const channel = await clientInstance.channels.fetch(LOG_CHANNEL_ID);
    if (channel && channel.isTextBased()) {
      await channel.send({ embeds: [embed] });
    }
  } catch (err) {
    console.warn('⚠️ 勤務終了ログチャンネルへの送信に失敗:', err?.message || err);
  }
}

client.once('clientReady', async () => {
  console.log(`🤖 ログイン完了: ${client.user.tag}`);
  await registerCommands();
});

client.on('error', (err) => {
  console.error('❌ Discordクライアントエラー:', err);
});

client.on('interactionCreate', async (interaction) => {
  const userId = interaction.user.id;
  const displayName = interaction.member?.displayName || interaction.user.username;

  try {
    if (interaction.isChatInputCommand()) {
      switch (interaction.commandName) {
        case 'panel': {
          const embed = new EmbedBuilder()
            .setTitle('🛡️ モデレーター勤怠管理パネル')
            .setDescription(
              '**勤務開始**でセッションを開始し、**勤務終了**で対応件数と引き継ぎメモを報告してください。'
            )
            .setColor(0x2563eb)
            .setTimestamp();

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
              .setLabel('自分の状態')
              .setStyle(ButtonStyle.Secondary)
          );

          await interaction.reply({ embeds: [embed], components: [row] });
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
            await interaction.editReply({ content: '📭 該当する勤怠ログはありませんでした。' });
            return;
          }

          const lines = logsList.slice(0, limit).map((item, idx) => {
            const id = item.logId || item.id || `#${idx + 1}`;
            const who = item.username || item.userId || '不明';
            const cases = item.casesCount ?? item.cases ?? 0;
            const start = item.startTime || item.startedAt || '-';
            const end = item.endTime || item.endedAt || '勤務中';
            const note = item.notes ? ` / ${String(item.notes).slice(0, 40)}` : '';
            return `**${id}** | **${who}** | ${start} 〜 ${end} | ${cases}件${note}`;
          });

          const embed = new EmbedBuilder()
            .setTitle('🗂️ 勤怠ログ一覧')
            .setColor(0x0284c7)
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
          const notes = interaction.options.getString('notes') || `手動追加（by ${displayName}）`;

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
            .setTitle('➕ 勤怠ログを手動追加しました')
            .setColor(0x0d9488)
            .addFields(
              { name: '対象ユーザー', value: `${targetUser}`, inline: true },
              { name: '対応件数', value: `${casesCount} 件`, inline: true },
              { name: '開始 / 終了', value: `${startTime} 〜 ${endTime || '未設定'}`, inline: false },
              { name: 'メモ', value: notes.slice(0, 1024), inline: false }
            )
            .setTimestamp();

          if (data?.logId || data?.id) {
            embed.setFooter({ text: `Log ID: ${data.logId || data.id}` });
          }

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
          await interaction.editReply({ content: `✏️ ログ \`${logId}\` を更新しました。` });
          break;
        }

        case 'delete-log': {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          const logId = interaction.options.getString('log_id', true);
          await gasClient.deleteLog(logId);
          await interaction.editReply({ content: `🗑️ ログ \`${logId}\` を削除しました。` });
          break;
        }

        case 'settings': {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          const key = interaction.options.getString('key');
          const value = interaction.options.getString('value');

          if (key && value !== null && value !== undefined) {
            await gasClient.setSetting(key, value);
            await interaction.editReply({ content: `⚙️ 設定を更新しました: \`${key}\` = \`${value}\`` });
          } else {
            const settings = await gasClient.getSettings();
            await interaction.editReply({
              content: `⚙️ **現在の設定**\n\`\`\`json\n${JSON.stringify(settings ?? {}, null, 2).slice(0, 1800)}\n\`\`\``,
            });
          }
          break;
        }
      }
    } else if (interaction.isButton()) {
      if (interaction.customId === 'shift_start') {
        if (busyUsers.has(userId)) {
          await interaction.reply({ content: '⏳ 処理中です。少し待ってください。', flags: MessageFlags.Ephemeral });
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
          .setTitle('勤務終了レポート');

        const casesInput = new TextInputBuilder()
          .setCustomId('cases_count')
          .setLabel('対応件数（数字・未入力なら0）')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setPlaceholder('例: 3');

        const noteInput = new TextInputBuilder()
          .setCustomId('shift_note')
          .setLabel('対応内容・引き継ぎ事項（任意）')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setPlaceholder('例: サーバー巡回、違反対応、引継ぎ事項など');

        modal.addComponents(
          new ActionRowBuilder().addComponents(casesInput),
          new ActionRowBuilder().addComponents(noteInput)
        );
        await interaction.showModal(modal);
      }
    } else if (interaction.isModalSubmit()) {
      if (interaction.customId === 'shift_end_modal') {
        if (busyUsers.has(userId)) {
          await interaction.reply({ content: '⏳ 処理中です。少し待ってください。', flags: MessageFlags.Ephemeral });
          return;
        }
        busyUsers.add(userId);
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
          const rawCases = interaction.fields.getTextInputValue('cases_count')?.trim();
          const casesCount = rawCases && !Number.isNaN(Number(rawCases)) ? Math.max(0, Math.floor(Number(rawCases))) : 0;
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
    console.error('❌ インタラクション処理エラー:', err);
    const msg = `⚠️ 処理中にエラーが発生しました: ${err?.message || err}`.slice(0, 1900);
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: msg, flags: MessageFlags.Ephemeral }).catch(() => {});
    } else {
      await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
});

process.on('unhandledRejection', (reason) => {
  console.error('❌ 未処理のPromise拒否:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('❌ 未捕捉の例外:', err);
});

client.login(TOKEN).catch((err) => {
  console.error('❌ Discordログイン失敗:', err);
});
