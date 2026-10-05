import type { ICredentialType, INodeProperties } from 'n8n-workflow';

export type YandexMailServer = 'imap.yandex.ru' | 'imap.ya.ru';

export type YandexMailCredentials = {
	user: string;
	appPassword: string;
	server: YandexMailServer;
};

export class YandexMailApi implements ICredentialType {
	name = 'yandexMailApi';

	displayName = 'Yandex Mail API';

	icon = 'file:yandex-mail.svg' as const;

	documentationUrl = 'https://yandex.ru/support/yandex-360/customers/mail/ru/mail-clients/others';

	supportedNodes = ['yandexMail', 'yandexMailTrigger'];

	properties: INodeProperties[] = [
		{
			displayName: 'Email',
			name: 'user',
			type: 'string',
			default: '',
			placeholder: 'name@yandex.ru',
			required: true,
			description: 'Full mailbox address, for example name@yandex.ru',
		},
		{
			displayName: 'App Password',
			name: 'appPassword',
			type: 'string',
			typeOptions: {
				password: true,
			},
			default: '',
			required: true,
			description:
				'Yandex app password for Mail, not the account password. Create it in Yandex ID → App passwords.',
		},
		{
			displayName: 'IMAP Server',
			name: 'server',
			type: 'options',
			options: [
				{
					name: 'imap.ya.ru (Outside Russia)',
					value: 'imap.ya.ru',
				},
				{
					name: 'imap.yandex.ru (Default)',
					value: 'imap.yandex.ru',
				},
			],
			default: 'imap.yandex.ru',
			description: 'Yandex IMAP host. Port 993 and TLS are fixed.',
		},
	];
}
