import React from 'react';
import ListItem from './ListItem';
import { Link } from 'react-router';

const ListItemGame = React.createClass({

	render(){
		const players = this.props.players.join(', ');
		return (
			<div className="list-item-game">
                <Link to={ "/game/" + this.props.id + "/" }><ListItem title={players} details={this.props.details} active={this.props.active} /></Link>
            </div>
		)
	}
});

export default ListItemGame;
