const Alexa = require('ask-sdk-core');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');

const ddbClient = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(ddbClient);
const TABLE_NAME = process.env.TABLE_NAME || 'BonsPoints';

// Normalise un prénom pour en faire une clé DynamoDB stable (sans accents, minuscules)
function normalizeKey(name) {
    return name
        .toLowerCase()
        .trim()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '');
}

async function getAccount(rawName) {
    const result = await ddb.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: { accountName: normalizeKey(rawName) }
    }));
    return result.Item || null;
}

async function getCreatorName(handlerInput) {
    try {
        const upsClient = handlerInput.serviceClientFactory.getUpsServiceClient();
        const name = await upsClient.getProfileGivenName();
        return name || 'le créateur du compte';
    } catch {
        return 'le créateur du compte';
    }
}

// ─── LaunchRequest ────────────────────────────────────────────────────────────

const LaunchRequestHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'LaunchRequest';
    },
    handle(handlerInput) {
        return handlerInput.responseBuilder
            .speak('Bienvenue dans Bons Points ! Vous pouvez créer un compte, ajouter ou retirer des bons points, ou consulter un total.')
            .reprompt('Que voulez-vous faire ?')
            .getResponse();
    }
};

// ─── CreateAccountIntent ──────────────────────────────────────────────────────

const CreateAccountIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && Alexa.getIntentName(handlerInput.requestEnvelope) === 'CreateAccountIntent';
    },
    async handle(handlerInput) {
        const accountNameSlot = Alexa.getSlotValue(handlerInput.requestEnvelope, 'AccountName');
        if (!accountNameSlot) {
            return handlerInput.responseBuilder
                .speak('Je n\'ai pas compris le prénom. Pour quel prénom souhaitez-vous créer un compte ?')
                .reprompt('Pour quel prénom souhaitez-vous créer un compte ?')
                .getResponse();
        }

        const existing = await getAccount(accountNameSlot);
        if (existing) {
            return handlerInput.responseBuilder
                .speak(`Un compte bons points pour ${accountNameSlot} existe déjà.`)
                .getResponse();
        }

        const creatorId = handlerInput.requestEnvelope.context.System.user.userId;
        const creatorName = await getCreatorName(handlerInput);

        await ddb.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: {
                accountName: normalizeKey(accountNameSlot),
                displayName: accountNameSlot,
                creatorId,
                creatorName,
                points: 0
            }
        }));

        return handlerInput.responseBuilder
            .speak(`J'ai créé le compte bons points pour ${accountNameSlot}. Il commence avec zéro points.`)
            .getResponse();
    }
};

// ─── AddPointsIntent ──────────────────────────────────────────────────────────

const AddPointsIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && Alexa.getIntentName(handlerInput.requestEnvelope) === 'AddPointsIntent';
    },
    async handle(handlerInput) {
        const accountNameSlot = Alexa.getSlotValue(handlerInput.requestEnvelope, 'AccountName');
        const pointsSlot = Alexa.getSlotValue(handlerInput.requestEnvelope, 'Points');

        if (!accountNameSlot || !pointsSlot) {
            return handlerInput.responseBuilder
                .speak('Je n\'ai pas bien compris. Dites par exemple : ajoute cinq bons points à Marie.')
                .getResponse();
        }

        const points = parseInt(pointsSlot, 10);
        if (isNaN(points)) {
            return handlerInput.responseBuilder
                .speak('Je n\'ai pas compris le nombre de points. Pouvez-vous répéter ?')
                .getResponse();
        }

        const account = await getAccount(accountNameSlot);
        if (!account) {
            return handlerInput.responseBuilder
                .speak(`Je ne trouve pas de compte bons points pour ${accountNameSlot}. Souhaitez-vous en créer un ?`)
                .getResponse();
        }

        const userId = handlerInput.requestEnvelope.context.System.user.userId;
        if (userId !== account.creatorId) {
            return handlerInput.responseBuilder
                .speak(`Seul ${account.creatorName} peut faire cela, désolé.`)
                .getResponse();
        }

        const result = await ddb.send(new UpdateCommand({
            TableName: TABLE_NAME,
            Key: { accountName: normalizeKey(accountNameSlot) },
            UpdateExpression: 'SET points = points + :pts',
            ExpressionAttributeValues: { ':pts': points },
            ReturnValues: 'UPDATED_NEW'
        }));

        const newTotal = result.Attributes.points;
        return handlerInput.responseBuilder
            .speak(`J'ai ajouté ${points} bons points à ${account.displayName}. Il a maintenant ${newTotal} bons points.`)
            .getResponse();
    }
};

// ─── RemovePointsIntent ───────────────────────────────────────────────────────

const RemovePointsIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && Alexa.getIntentName(handlerInput.requestEnvelope) === 'RemovePointsIntent';
    },
    async handle(handlerInput) {
        const accountNameSlot = Alexa.getSlotValue(handlerInput.requestEnvelope, 'AccountName');
        const pointsSlot = Alexa.getSlotValue(handlerInput.requestEnvelope, 'Points');

        if (!accountNameSlot || !pointsSlot) {
            return handlerInput.responseBuilder
                .speak('Je n\'ai pas bien compris. Dites par exemple : retire trois bons points à Thomas.')
                .getResponse();
        }

        const points = parseInt(pointsSlot, 10);
        if (isNaN(points)) {
            return handlerInput.responseBuilder
                .speak('Je n\'ai pas compris le nombre de points. Pouvez-vous répéter ?')
                .getResponse();
        }

        const account = await getAccount(accountNameSlot);
        if (!account) {
            return handlerInput.responseBuilder
                .speak(`Je ne trouve pas de compte bons points pour ${accountNameSlot}.`)
                .getResponse();
        }

        const userId = handlerInput.requestEnvelope.context.System.user.userId;
        if (userId !== account.creatorId) {
            return handlerInput.responseBuilder
                .speak(`Seul ${account.creatorName} peut faire cela, désolé.`)
                .getResponse();
        }

        const result = await ddb.send(new UpdateCommand({
            TableName: TABLE_NAME,
            Key: { accountName: normalizeKey(accountNameSlot) },
            UpdateExpression: 'SET points = points - :pts',
            ExpressionAttributeValues: { ':pts': points },
            ReturnValues: 'UPDATED_NEW'
        }));

        const newTotal = result.Attributes.points;
        return handlerInput.responseBuilder
            .speak(`J'ai retiré ${points} bons points à ${account.displayName}. Il lui reste ${newTotal} bons points.`)
            .getResponse();
    }
};

// ─── CheckPointsIntent ────────────────────────────────────────────────────────

const CheckPointsIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && Alexa.getIntentName(handlerInput.requestEnvelope) === 'CheckPointsIntent';
    },
    async handle(handlerInput) {
        const accountNameSlot = Alexa.getSlotValue(handlerInput.requestEnvelope, 'AccountName');

        if (!accountNameSlot) {
            return handlerInput.responseBuilder
                .speak('Pour quel prénom voulez-vous connaître les bons points ?')
                .reprompt('Quel est le prénom ?')
                .getResponse();
        }

        const account = await getAccount(accountNameSlot);
        if (!account) {
            return handlerInput.responseBuilder
                .speak(`Je ne trouve pas de compte bons points pour ${accountNameSlot}.`)
                .getResponse();
        }

        const pts = account.points;
        const label = pts <= 1 ? 'bon point' : 'bons points';
        return handlerInput.responseBuilder
            .speak(`${account.displayName} a ${pts} ${label}.`)
            .getResponse();
    }
};

// ─── Built-in intents ─────────────────────────────────────────────────────────

const HelpIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.HelpIntent';
    },
    handle(handlerInput) {
        return handlerInput.responseBuilder
            .speak('Pour créer un compte, dites : crée un compte bons points pour, suivi du prénom. Pour ajouter des points, dites : ajoute, le nombre, bons points à, suivi du prénom. Pour retirer des points, dites : retire. Pour consulter le total, dites : combien de bons points a, suivi du prénom.')
            .reprompt('Que voulez-vous faire ?')
            .getResponse();
    }
};

const CancelAndStopIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
            && (Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.CancelIntent'
                || Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.StopIntent');
    },
    handle(handlerInput) {
        return handlerInput.responseBuilder
            .speak('Au revoir !')
            .getResponse();
    }
};

const ErrorHandler = {
    canHandle() {
        return true;
    },
    handle(handlerInput, error) {
        console.error('Erreur:', error);
        return handlerInput.responseBuilder
            .speak('Désolé, je n\'ai pas pu traiter votre demande. Veuillez réessayer.')
            .reprompt('Que voulez-vous faire ?')
            .getResponse();
    }
};

// ─── Export ───────────────────────────────────────────────────────────────────

exports.handler = Alexa.SkillBuilders.custom()
    .addRequestHandlers(
        LaunchRequestHandler,
        CreateAccountIntentHandler,
        AddPointsIntentHandler,
        RemovePointsIntentHandler,
        CheckPointsIntentHandler,
        HelpIntentHandler,
        CancelAndStopIntentHandler
    )
    .addErrorHandlers(ErrorHandler)
    .withApiClient(new Alexa.DefaultApiClient())
    .lambda();
