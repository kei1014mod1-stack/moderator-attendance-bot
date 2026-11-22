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
const GasClientClass = require('./gasClient.js');

if (typeof dns.setDefaultResultOrder === 'function') {
  dns.setDefaultResultOrder('ipv4first');
}

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;
const PORT = Number(process.env.PORT || 10000);

const cleanToken = String(TOKEN || '').trim();
const gasClient = new GasClientClass(GAS_WEB_APP_URL);

console.log('🚀 index.js 起動シーケンスを開始します...');
console.log(
  `🔍 環境変数確認: TOKEN_LEN=${cleanToken.length}, HAS_WS=${/\s/.test(cleanToken)}, HAS_CLIENT_ID=${Boolean(CLIENT_ID)}, HAS_GAS_URL=${Boolean(GAS_WEB_APP_URL)}`
);

// Render Web Service 用のヘルスチェックサーバー
const healthServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('OK - Moderator Attendance Bot');
});

healthServer.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 HTTPヘルスチェックサーバーがポート ${PORT} で待機中です。`);
});

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const commands = [
  new SlashCommandBuilder()
    .setName('panel')
    .setDescription('モデレーター勤怠パネルを設置します')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('現在の勤務状況を確認します'),
].map((cmd) => cmd.toJSON());

async function registerCommands() {
  if (!cleanToken || !CLIENT_ID) {
    console.warn('⚠️ DISCORD_TOKEN または CLIENT_ID が未設定のためコマンド登録をスキップします。');
    return;
  }

  try {
    const rest = new REST({ version: '10' }).setToken(cleanToken);
    console.log('⏳ グローバルスラッシュコマンドを登録中...');
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('✅ グローバルスラッシュコマンドを登録しました。');
  } catch (err) {
    console.error('❌ スラッシュコマンド登録エラー:', err);
  }
}

function formatResultMessage(fallbackText, data) {
  if (!data) return fallbackText;
  if (typeof data === 'string') return data;
  if (data.message) return data.message;
  return `${fallbackText}\n\`\`\`json\n${JSON.stringify(data, null, 2).slice(0, 1500)}\n\`\`\``;
}

client.on('debug', (msg) => {
  if (!msg.includes('Heartbeat')) {
    console.log('🪲 [debug]:', msg);
  }
});

client.once('clientReady', async () => {
  console.log(`🤖 ログイン完了: ${client.user.tag}`);
  await registerCommands();
});

client.on('error', (err) => {
  console.error('❌ Discordクライアントエラー:', err);
});

client.on('interactionCreate', async (interaction) => {
  try {
    const displayName = interaction.member?.displayName || interaction.user.username;

    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'panel') {
        const embed = new EmbedBuilder()
          .setTitle('🛡️ モデレーター勤怠管理パネル')
          .setDescription('下のボタンを押して勤務開始・勤務終了を記録してください。')
          .setColor(0x2b6cb0);

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('shift_start')
            .setLabel('勤務開始')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId('shift_end')
            .setLabel('勤務終了')
            .setStyle(ButtonStyle.Danger)
        );

        await interaction.reply({ embeds: [embed], components: [row] });
      } else if (interaction.commandName === 'status') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const data = await gasClient.getActive(interaction.user.id);
        await interaction.editReply({
          content: formatResultMessage('📋 現在の勤務状況を取得しました。', data),
        });
      }
    } else if (interaction.isButton()) {
      if (interaction.customId === 'shift_start') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const data = await gasClient.clockIn(interaction.user.id, displayName);
        await interaction.editReply({
          content: formatResultMessage('✅ 勤務開始を記録しました。', data),
        });
      } else if (interaction.customId === 'shift_end') {
        const modal = new ModalBuilder()
          .setCustomId('shift_end_modal')
          .setTitle('勤務終了レポート');

        const casesInput = new TextInputBuilder()
          .setCustomId('cases_count')
          .setLabel('対応件数（数字・未入力なら0）')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setPlaceholder('例：3');

        const noteInput = new TextInputBuilder()
          .setCustomId('shift_note')
          .setLabel('対応内容・引き継ぎ事項（任意）')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setPlaceholder('例：サーバー巡回、迷惑行為対応など');

        modal.addComponents(
          new ActionRowBuilder().addComponents(casesInput),
          new ActionRowBuilder().addComponents(noteInput)
        );
        await interaction.showModal(modal);
      }
    } else if (interaction.isModalSubmit()) {
      if (interaction.customId === 'shift_end_modal') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const rawCases = interaction.fields.getTextInputValue('cases_count')?.trim();
        const casesCount = rawCases && !Number.isNaN(Number(rawCases)) ? Number(rawCases) : 0;
        const notes = interaction.fields.getTextInputValue('shift_note') || '';

        const data = await gasClient.clockOut(
          interaction.user.id,
          displayName,
          casesCount,
          notes
        );
        await interaction.editReply({
          content: formatResultMessage('🛑 勤務終了を記録しました。', data),
        });
      }
    }
  } catch (err) {
    console.error('❌ インタラクション処理エラー:', err);
    if (interaction.deferred || interaction.replied) {
      await interaction
        .followUp({
          content: `⚠️ 処理中にエラーが発生しました: ${err?.message || err}`,
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => {});
    } else {
      await interaction
        .reply({
          content: `⚠️ 処理中にエラーが発生しました: ${err?.message || err}`,
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => {});
    }
  }
});

(async () => {
  console.log('🔄 Discordへログインを開始します...');
  const loginTimer = setTimeout(() => {
    console.warn('⚠️ ログイン開始から10秒経過しましたが完了していません。');
  }, 10000);

  client
    .login(cleanToken)
    .then(() => {
      clearTimeout(loginTimer);
      console.log('✅ client.login() Promise が解決しました。');
    })
    .catch((err) => {
      clearTimeout(loginTimer);
      console.error('❌ Discordログイン失敗:', err);
    });
})();
