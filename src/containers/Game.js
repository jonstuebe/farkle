import React from 'react';
import { Link } from 'react-router';
import _ from 'lodash';

import history from '../history';

import TitleBar from '../components/TitleBar';
import ListItems from '../components/ListItems';
import ListItem from '../components/ListItem';
import BottomDrawer from '../components/BottomDrawer';
import Button from '../components/Button';

const Game = React.createClass({

    getInitialState() {
        return {
            players: [
                {
                    first_name: 'Jon',
                    last_name: 'Stuebe',
                    points: 0,
                },
                {
                    first_name: 'Kevin',
                    last_name: 'Platt',
                    points: 0,
                }
            ]
        }
    },

    getPlayerSlug(player) {
        return player.first_name.toLowerCase() + '-' + player.last_name.toLowerCase();
    },

    onSelectPlayer(player) {
        history.replaceState(null, `/player/${this.getPlayerSlug(player)}`);
    },

    renderPlayers() {

        let players = this.state.players.map((player, index) => {
            return (
                <ListItem title={`${player.first_name} ${player.last_name}`} details={`${player.points} points`} key={index} onClick={() => {
                        this.onSelectPlayer(player);
                }} />
            );
        })

        return players;

    },

    render(){

        // const id = location.pathname.slice(1).split('/')[1];

        return (
            <div>
                <TitleBar title="Game" back={'/players'} />
                <ListItems>
                    {this.renderPlayers()}
                </ListItems>
                { /*
                <BottomDrawer>
                    <Button to={`${location.pathname} start/`} light={false}>play turn</Button>
                </BottomDrawer>
                */ }
            </div>
        )
    }
});

export default Game;
